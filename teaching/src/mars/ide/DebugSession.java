package mars.ide;

import static mars.ide.Json.obj;

import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import mars.*;
import mars.assembler.*;
import mars.mips.hardware.*;
import mars.mips.instructions.*;
import mars.simulator.*;

/** One serialized local machine. Execution always uses the original MARS Simulator. */
public final class DebugSession {

  public final String id = UUID.randomUUID().toString();
  public int programVersion = 0,
    stateVersion = 0;
  private MIPSprogram program;
  private Path projectDir;
  private final TraceHistory<Entry> history = new TraceHistory<>();
  private final Map<Integer, Map<String, Object>> instructions =
    new LinkedHashMap<>();
  private final List<Object> symbols = new ArrayList<>(),
    diagnostics = new ArrayList<>();
  private final Map<String, String> sources = new LinkedHashMap<>();
  private String status = "empty",
    error = "",
    stopReason = "";
  private boolean delay;
  private int memoryBase = Memory.dataBaseAddress;
  /** Executions per instruction address in history before the cursor (hit counts). */
  private final Map<Integer, Integer> executed = new HashMap<>();
  /** Logpoint messages produced by the current request. */
  private final List<Object> logs = new ArrayList<>();
  /** Source lines of lookahead the client asked for with this request; 0 = none. */
  private int lookaheadLines = 0;

  private record Entry(
    MachineState before,
    MachineState after,
    Map<String, Object> event
  ) {}

  public DebugSession() {
    Globals.initialize(false);
    MemoryConfigurations.setCurrentConfiguration(MemoryConfigurations.getDefaultConfiguration());
  }

  private MachineState snapshot() {
    return MachineState.capture(status, error);
  }

  private void restore(MachineState state) {
    state.restore();
    status = state.status;
    error = state.error;
  }

  @SuppressWarnings("unchecked")
  public Map<String, Object> assemble(Map<String, Object> request)
    throws Exception {
    TraceHooks.active.remove();
    history.clear();
    executed.clear();
    history.position = 0;
    programVersion++;
    stateVersion++;
    instructions.clear();
    symbols.clear();
    diagnostics.clear();
    sources.clear();
    status = "empty";
    error = "";
    stopReason = "";
    if (projectDir != null) {
      try (var walk = Files.walk(projectDir)) {
        for (var p : walk.sorted(Comparator.reverseOrder()).toList())
          Files.deleteIfExists(p);
      }
    }
    projectDir = Files.createTempDirectory("mars-teaching-");
    Map<String, Object> files = (Map<String, Object>) request.get("files");
    if (files == null || files.isEmpty()) throw new IllegalArgumentException(
      "Provide source files"
    );
    for (var e : files.entrySet()) {
      String name = e.getKey();
      Path p = projectDir.resolve(name).normalize();
      if (
        !p.startsWith(projectDir) || name.startsWith("/")
      ) throw new IllegalArgumentException("Project-relative paths required");
      String src = e.getValue().toString();
      if (src.length() > 1_000_000) throw new IllegalArgumentException(
        "Source limit 1 MB"
      );
      if (
        src.matches("(?s).*\\.(include|incbin)\\b.*")
      ) throw new IllegalArgumentException(
        "Use explicit project source files; include/incbin is not enabled"
      );
      Files.createDirectories(p.getParent());
      Files.writeString(p, src);
      sources.put(name, src);
    }
    VirtualIO.current = new VirtualIO();
    var data = (Map<String, Object>) request.getOrDefault("data", Map.of());
    for (var e : data.entrySet())
      VirtualIO.current.files.put(
        e.getKey(),
        e.getValue().toString().getBytes(StandardCharsets.UTF_8)
      );
    for (Object input : (List<Object>) request.getOrDefault(
      "inputs",
      List.of()
    ))
      VirtualIO.current.inputs.add(input.toString());
    delay = Boolean.TRUE.equals(request.get("delay"));
    Globals.getSettings().setBooleanSettingNonPersistent(
      Settings.DELAYED_BRANCHING_ENABLED,
      delay
    );
    Globals.getSettings().setBooleanSettingNonPersistent(
      Settings.SELF_MODIFYING_CODE_ENABLED,
      false
    );
    Globals.getSettings().setBooleanSettingNonPersistent(
      Settings.START_AT_MAIN,
      true
    );
    Globals.memory.clear();
    RegisterFile.resetRegisters();
    Coprocessor0.resetRegisters();
    Coprocessor1.resetRegisters();
    DelayedBranch.restore(new int[] { 0, 0 });
    Globals.exitCode = 0;
    program = new MIPSprogram();
    Globals.program = program;
    var names = new ArrayList<String>();
    for (String name : sources.keySet())
      if (name.endsWith(".s") || name.endsWith(".asm")) names.add(
        projectDir.resolve(name).toString()
      );
    String entry = request
      .getOrDefault("entry", sources.keySet().iterator().next())
      .toString();
    try {
      ArrayList programs = program.prepareFilesForAssembly(
        names,
        projectDir.resolve(entry).toString(),
        null
      );
      ErrorList warnings = program.assemble(programs, true, false);
      addDiagnostics(warnings);
      program.getBackStepper().setEnabled(false);
      RegisterFile.initializeProgramCounter(true);
      for (Object x : program.getMachineList()) {
        ProgramStatement s = (ProgramStatement) x;
        instructions.put(s.getAddress(), statement(s));
      }
      addSymbols(Globals.symbolTable, "");
      for (Object p : programs) {
        MIPSprogram mp = (MIPSprogram) p;
        addSymbols(mp.getLocalSymbolTable(), relative(mp.getFilename()));
      }
      status = "paused";
    } catch (ProcessingException e) {
      addDiagnostics(e.errors());
      status = "error";
      error = "Assembly failed";
    }
    memoryBase = Memory.dataBaseAddress;
    return state(true);
  }

  private String relative(String path) {
    if (path == null) return "";
    try {
      return projectDir.relativize(Path.of(path)).toString();
    } catch (Exception e) {
      return path;
    }
  }

  private void addDiagnostics(ErrorList errors) {
    if (errors != null) for (Object x : errors.getErrorMessages()) {
      ErrorMessage e = (ErrorMessage) x;
      diagnostics.add(
        obj(
          "file",
          relative(e.getFilename()),
          "line",
          e.getLine(),
          "column",
          e.getPosition(),
          "message",
          e.getMessage(),
          "warning",
          e.isWarning()
        )
      );
    }
  }

  private void addSymbols(SymbolTable table, String file) {
    for (Object x : table.getAllSymbols()) {
      Symbol s = (Symbol) x;
      symbols.add(
        obj(
          "name",
          s.getName(),
          "address",
          s.getAddress(),
          "data",
          s.getType(),
          "file",
          file
        )
      );
    }
  }

  private Map<String, Object> statement(ProgramStatement s) {
    String file = relative(s.getSourceFile());
    String basic = s.getPrintableBasicAssemblyStatement();
    String op = s.getInstruction().getName();
    var m = obj(
      "address",
      s.getAddress(),
      "file",
      file,
      "line",
      s.getSourceLine(),
      "source",
      s.getSource(),
      "basic",
      basic,
      "op",
      op,
      "binary",
      s.getBinaryStatement(),
      "description",
      s.getInstruction().getDescription()
    );
    int bits = s.getBinaryStatement(),
      opcode = bits >>> 26;
    boolean branch =
      opcode == 1 ||
      (opcode >= 4 && opcode <= 7) ||
      (opcode == 17 && ((bits >>> 21) & 31) == 8);
    boolean direct = opcode == 2 || opcode == 3;
    boolean indirect = opcode == 0 && ((bits & 63) == 8 || (bits & 63) == 9);
    m.put(
      "flow",
      branch
        ? "branch"
        : direct
          ? opcode == 3
            ? "call"
            : "jump"
          : indirect
            ? (bits & 63) == 9
              ? "call"
              : "indirect"
            : "next"
    );
    if (branch) m.put("target", s.getAddress() + 4 + ((short) bits << 2));
    if (direct) m.put(
      "target",
      ((s.getAddress() + 4) & 0xf0000000) | ((bits & 0x3ffffff) << 2)
    );
    return m;
  }

  private String blocked(boolean preview) throws Exception {
    if (!status.equals("paused") && !status.equals("waiting")) return status;
    ProgramStatement s = Globals.memory.getStatementNoNotify(
      RegisterFile.getProgramCounter()
    );
    if (s == null) return "ended";
    if (s.getInstruction().getName().equals("syscall")) {
      int n = RegisterFile.getRegisters()[2].getValueNoNotify();
      if (
        Set.of(8, 14, 15).contains(n) &&
        (RegisterFile.getValue(n == 8 ? 5 : 6) < 0 ||
          RegisterFile.getValue(n == 8 ? 5 : 6) > 1_000_000)
      ) return "I/O request exceeds 1 MB";
      if (!((n >= 1 && n <= 17) || (n >= 34 && n <= 36))) return (
        "unsupported syscall " + n
      );
      if (
        Set.of(5, 6, 7, 8, 12).contains(n) ||
        (n == 14 && RegisterFile.getRegisters()[4].getValueNoNotify() == 0)
      ) {
        if (
          preview || VirtualIO.current.cursor >= VirtualIO.current.inputs.size()
        ) return "waiting-input";
      }
    }
    return "";
  }

  private Entry execute() throws Exception {
    MachineState before = snapshot();
    int pc = RegisterFile.getProgramCounter();
    var accesses = new ArrayList<Map<String, Object>>();
    String failure = "";
    boolean done = false;
    TraceHooks.active.set(accesses);
    try {
      done = program.simulateStepAtPC(null);
    } catch (ProcessingException e) {
      failure = e.errors() == null ? "" : e.errors().generateErrorReport();
      done = true;
    } finally {
      TraceHooks.active.remove();
    }
    status = done ? (failure.isEmpty() ? "ended" : "error") : "paused";
    error = failure;
    if (
      !done &&
      Globals.memory.getStatementNoNotify(RegisterFile.getProgramCounter()) ==
        null
    ) status = "ended";
    MachineState after = snapshot();
    var event = obj(
      "step",
      history.position + 1,
      "pc",
      pc,
      "nextPC",
      RegisterFile.getProgramCounter(),
      "instruction",
      instructions.get(pc),
      "accesses",
      accesses,
      "output",
      VirtualIO.current.output.substring(
        Math.min(before.io.output.length(), VirtualIO.current.output.length())
      ),
      "status",
      status,
      "error",
      error,
      "delayBefore",
      before.branch,
      "delayAfter",
      after.branch,
      "service",
      instructions.get(pc).get("op").equals("syscall") ? before.gpr[2] : null
    );
    return new Entry(before, after, event);
  }

  @SuppressWarnings("unchecked")
  private void memoryApply(Entry e, boolean forward) throws Exception {
    var accesses = (List<Map<String, Object>>) e.event.get("accesses");
    for (int i = 0; i < accesses.size(); i++) {
      var a = accesses.get(forward ? i : accesses.size() - 1 - i);
      if (
        a.get("kind").equals("memory") && Boolean.TRUE.equals(a.get("write"))
      ) {
        Globals.memory.set(
          ((Number) a.get("address")).intValue(),
          ((Number) a.get(forward ? "value" : "before")).intValue(),
          ((Number) a.get("width")).intValue()
        );
      }
    }
  }

  public Map<String, Object> preview() throws Exception {
    String block = blocked(true);
    int pc = RegisterFile.getProgramCounter();
    if (!block.isEmpty()) {
      var s = instructions.get(pc);
      var accesses = new ArrayList<Object>();
      if (block.equals("waiting-input")) accesses.add(
        obj(
          "kind",
          "register",
          "name",
          "$v0",
          "write",
          false,
          "value",
          RegisterFile.getValue(2),
          "before",
          RegisterFile.getValue(2)
        )
      );
      return obj(
        "status",
        block,
        "pc",
        pc,
        "instruction",
        s,
        "accesses",
        accesses,
        "step",
        history.position + 1
      );
    }
    Entry e = execute();
    try {
      var p = new LinkedHashMap<>(e.event);
      p.put(
        "status",
        e.after.status.equals("error") ? "predicted-error" : "exact"
      );
      return p;
    } finally {
      memoryApply(e, false);
      restore(e.before);
    }
  }

  static final int LOOKAHEAD_INSTRUCTIONS = 64;

  /**
   * Executes up to {@code lines} source lines ahead on the real core, grouped
   * like source stepping, then undoes every step in reverse order. Blocked
   * steps (input, unsupported services, end) stop the walk instead of being
   * guessed, so the result is exactly what the following steps will do.
   */
  public Map<String, Object> lookahead(int lines) throws Exception {
    lines = Math.max(1, Math.min(8, lines));
    var done = new ArrayList<Entry>();
    var groups = new ArrayList<Map<String, Object>>();
    String stop = "";
    String current = null;
    List<Object> events = null;
    try {
      while (stop.isEmpty()) {
        int pc = RegisterFile.getProgramCounter();
        var ins = instructions.get(pc);
        String block = blocked(true);
        if (!block.isEmpty()) stop = block;
        else if (ins == null) stop = "ended";
        else if (done.size() >= LOOKAHEAD_INSTRUCTIONS) stop =
          "instruction-limit";
        if (!stop.isEmpty()) break;
        String key = ins.get("file") + ":" + ins.get("line");
        if (!key.equals(current)) {
          if (groups.size() == lines) {
            stop = "window";
            break;
          }
          current = key;
          events = new ArrayList<>();
          groups.add(
            obj(
              "file",
              ins.get("file"),
              "line",
              ins.get("line"),
              "address",
              pc,
              "events",
              events
            )
          );
        }
        Entry e = execute();
        done.add(e);
        e.event.put("step", history.position + done.size());
        events.add(e.event);
        if (status.equals("error")) stop = "error";
        else if (status.equals("ended")) stop = "ended";
      }
    } finally {
      for (int i = done.size() - 1; i >= 0; i--) {
        memoryApply(done.get(i), false);
        restore(done.get(i).before);
      }
    }
    int pc = RegisterFile.getProgramCounter();
    if (!done.isEmpty()) pc = ((Number) done
        .get(done.size() - 1)
        .event.get("nextPC")).intValue();
    // A finished program has no next location; errors stop at the faulting step.
    var at = stop.equals("ended") ? null : instructions.get(pc);
    // The last group is cut short when the walk stops inside a pseudo-instruction.
    boolean complete =
      at == null ||
      groups.isEmpty() ||
      !(at.get("file") + ":" + at.get("line")).equals(current);
    return obj(
      "lines",
      lines,
      "groups",
      groups,
      "complete",
      complete,
      "stop",
      stop,
      "stopAt",
      at == null
        ? null
        : obj("address", pc, "file", at.get("file"), "line", at.get("line"))
    );
  }

  private boolean step() throws Exception {
    String block = blocked(false);
    if (!block.isEmpty()) {
      status = block.equals("waiting-input")
        ? "waiting"
        : block.equals("ended")
          ? "ended"
          : "error";
      if (status.equals("error")) error = block;
      stopReason = block;
      return false;
    }
    if (history.full()) {
      stopReason = "History limit 100000 steps; reset to continue";
      return false;
    }
    Entry e = execute();
    history.append(e);
    executed.merge(((Number) e.event.get("pc")).intValue(), 1, Integer::sum);
    stateVersion++;
    return true;
  }

  public void seek(int target) throws Exception {
    history.seek(target, (entry, forward) -> {
      executed.merge(
        ((Number) entry.event.get("pc")).intValue(),
        forward ? 1 : -1,
        Integer::sum
      );
      memoryApply(entry, forward);
      restore(forward ? entry.after : entry.before);
    });
    stateVersion++;
    stopReason = "History #" + history.position;
  }

  /**
   * History position one source line back or forward, grouping steps the way
   * lookahead does: consecutive events on the same line that run sequentially
   * (a pseudo-instruction's expansion) form one line.
   */
  private int lineTarget(int direction) {
    int n = history.position;
    if (direction < 0) {
      if (n == 0) return 0;
      int k = n - 1;
      while (k > 0 && sameLine(k - 1, k)) k--;
      return k;
    }
    if (n >= history.size()) return n;
    int m = n + 1;
    while (m < history.size() && sameLine(m - 1, m)) m++;
    return m;
  }

  private boolean sameLine(int a, int b) {
    var x = history.get(a).event;
    var y = history.get(b).event;
    @SuppressWarnings("unchecked")
    var ix = (Map<String, Object>) x.get("instruction");
    @SuppressWarnings("unchecked")
    var iy = (Map<String, Object>) y.get("instruction");
    return (
      ix.get("file").equals(iy.get("file")) &&
      ix.get("line").equals(iy.get("line")) &&
      ((Number) y.get("pc")).intValue() == ((Number) x.get("pc")).intValue() + 4
    );
  }

  public Map<String, Object> command(Map<String, Object> request)
    throws Exception {
    String command = request.getOrDefault("command", "state").toString();
    lookaheadLines = request.get("lookahead") instanceof Number n
      ? n.intValue()
      : 0;
    if (command.equals("assemble")) return assemble(request);
    if (program == null) return state(false);
    if (
      request.containsKey("programVersion") &&
      ((Number) request.get("programVersion")).intValue() != programVersion
    ) throw new IllegalArgumentException("Stale program version");
    // Only commands that move the machine replace why it stopped; refreshing
    // the state or the memory view keeps it (round-3 trial: opening focus
    // mode turned "停在断点前" into "已暂停").
    if (!Set.of("state", "memory").contains(command)) stopReason = "";
    logs.clear();
    switch (command) {
      case "step" -> step();
      case "back" -> seek(Math.max(0, history.position - 1));
      case "seek" -> seek(((Number) request.get("step")).intValue());
      case "line" -> seek(
        lineTarget(((Number) request.getOrDefault("direction", 1)).intValue())
      );
      case "input" -> {
        VirtualIO.current.inputs.add(
          request.getOrDefault("value", "").toString()
        );
        if (status.equals("waiting")) status = "paused";
        stateVersion++;
      }
      case "source", "over", "out", "run" -> run(command, request);
      case "memory" -> memoryBase = (
        (Number) request.get("address")
      ).intValue();
      case "state" -> {
      }
      default -> throw new IllegalArgumentException("Unknown command");
    }
    return state(false);
  }

  @SuppressWarnings("unchecked")
  private void run(String mode, Map<String, Object> req) throws Exception {
    int limit = Math.min(
      mode.equals("over") || mode.equals("out") ? 100000 : 1000,
      ((Number) req.getOrDefault("limit", 1000)).intValue()
    );
    var first = instructions.get(RegisterFile.getProgramCounter());
    if (first == null) return;
    String source = first.get("file") + ":" + first.get("line");
    int depth = 0;
    boolean stepped = false;
    for (int i = 0; i < limit; i++) {
      int pc = RegisterFile.getProgramCounter();
      if (stepped || !Boolean.TRUE.equals(req.get("skipBreakpoint"))) {
        for (Object item : (List<Object>) req.getOrDefault(
          "breakpoints",
          List.of()
        )) {
          var bp = (Map<String, Object>) item;
          if (((Number) bp.get("address")).intValue() != pc) continue;
          if (!condition(bp.getOrDefault("condition", "").toString())) continue;
          // Hit count N: pause before the Nth execution of this instruction since S0.
          int hit = bp.get("hit") instanceof Number n ? n.intValue() : 0;
          if (hit > 0 && executed.getOrDefault(pc, 0) + 1 != hit) continue;
          String log = bp.getOrDefault("log", "").toString();
          if (!log.isBlank()) {
            if (logs.size() < 200) logs.add(
              obj("step", history.position, "address", pc, "text", message(log))
            );
            continue;
          }
          stopReason = "Breakpoint before " + Integer.toUnsignedString(pc, 16);
          return;
        }
      }
      var ins = instructions.get(pc);
      if (ins == null) return;
      if (
        stepped &&
        mode.equals("source") &&
        !source.equals(ins.get("file") + ":" + ins.get("line"))
      ) return;
      if (!step()) return;
      stepped = true;
      var e = history.get(history.position - 1);
      for (Object item : (List<Object>) req.getOrDefault(
        "watches",
        List.of()
      )) {
        var w = (Map<String, Object>) item;
        for (var a : (List<Map<String, Object>>) e.event.get("accesses")) {
          String access = Boolean.TRUE.equals(a.get("write"))
            ? "write"
            : "read";
          if (
            !w.getOrDefault("access", "write").equals("both") &&
            !w.getOrDefault("access", "write").equals(access)
          ) continue;
          boolean hit = w.containsKey("register")
            ? w.get("register").equals(a.get("name"))
            : a.containsKey("address") &&
              Integer.compareUnsigned(
                ((Number) w.get("address")).intValue(),
                ((Number) a.get("address")).intValue()
              ) >= 0 &&
              Integer.compareUnsigned(
                ((Number) w.get("address")).intValue(),
                ((Number) a.get("address")).intValue() +
                  ((Number) a.get("width")).intValue()
              ) < 0;
          if (hit) {
            stopReason = "Watchpoint " + access;
            return;
          }
        }
      }
      if (ins.get("flow").equals("call")) depth++;
      if (
        ins.get("op").equals("jr") &&
        ins.get("basic").toString().matches(".*(\\$31|\\$ra).*")
      ) depth--;
      if (!status.equals("paused")) return;
      if (
        mode.equals("over") && depth <= 0 && DelayedBranch.checkpoint()[0] == 0
      ) return;
      if (
        mode.equals("out") && depth < 0 && DelayedBranch.checkpoint()[0] == 0
      ) return;
    }
    stopReason = "Batch complete";
  }

  /** Consumed inputs with the output offset where the console shows them. */
  private List<Object> inputEchoes() {
    var out = new ArrayList<Object>();
    if (VirtualIO.current == null) return out;
    var io = VirtualIO.current;
    for (int i = 0; i < io.echoAt.size(); i++) out.add(
      obj("at", io.echoAt.get(i), "text", io.inputs.get(i))
    );
    return out;
  }

  /** Logpoint text with {$reg} as decimal and {$reg:x} as hex. */
  private String message(String template) {
    var m = java.util.regex.Pattern.compile("\\{(\\$\\w+)(:x)?\\}").matcher(
      template
    );
    var out = new StringBuilder();
    while (m.find()) {
      Register r = RegisterFile.getUserRegister(m.group(1));
      String v = r == null
        ? m.group()
        : m.group(2) != null
          ? String.format("0x%08x", r.getValueNoNotify())
          : Integer.toString(r.getValueNoNotify());
      m.appendReplacement(out, java.util.regex.Matcher.quoteReplacement(v));
    }
    m.appendTail(out);
    return out.toString();
  }

  private boolean condition(String text) {
    if (text.isBlank()) return true;
    var m = java.util.regex.Pattern.compile(
      "\\s*(\\$\\w+)\\s*(==|!=|<=|>=|<|>)\\s*(-?(?:0x[0-9a-fA-F]+|[0-9]+))\\s*"
    ).matcher(text);
    if (!m.matches()) throw new IllegalArgumentException(
      "Condition: $register == integer (or != < <= > >=)"
    );
    Register r = RegisterFile.getUserRegister(m.group(1));
    if (r == null) throw new IllegalArgumentException("Unknown register");
    long a = r.getValueNoNotify(),
      b = Long.decode(m.group(3));
    return switch (m.group(2)) {
      case "==" -> a == b;
      case "!=" -> a != b;
      case "<" -> a < b;
      case ">" -> a > b;
      case "<=" -> a <= b;
      default -> a >= b;
    };
  }

  public Map<String, Object> state(boolean includeProgram) throws Exception {
    var regs = new ArrayList<Object>();
    for (Register r : RegisterFile.getRegisters())
      regs.add(
        obj(
          "name",
          r.getName(),
          "number",
          r.getNumber(),
          "value",
          r.getValueNoNotify()
        )
      );
    regs.add(
      obj("name", "hi", "number", 33, "value", RegisterFile.getValue(33))
    );
    regs.add(
      obj("name", "lo", "number", 34, "value", RegisterFile.getValue(34))
    );
    var memory = new ArrayList<Object>();
    for (int i = 0; i < 128; i++) {
      int a = memoryBase + i;
      try {
        memory.add(obj("address", a, "value", Globals.memory.getByte(a)));
      } catch (AddressErrorException e) {
        memory.add(obj("address", a, "value", null));
      }
    }
    var recent = new ArrayList<Object>();
    int start = Math.max(0, history.position - 150);
    for (
      int i = start;
      i < Math.min(history.size(), history.position + 20);
      i++
    ) recent.add(history.get(i).event);
    var lastWriters = new LinkedHashMap<String, Object>();
    var edges = new LinkedHashMap<String, Integer>();
    var calls = new ArrayList<Object>();
    for (int i = 0; i < history.position; i++) {
      var e = history.get(i).event;
      for (var a : (List<Map<String, Object>>) e.get("accesses"))
        if (Boolean.TRUE.equals(a.get("write"))) {
          String key = a.get("kind").equals("register")
            ? a.get("name").toString()
            : "mem:" + a.get("address");
          lastWriters.put(key, i + 1);
          if (a.get("kind").equals("memory")) for (
            int offset = 1;
            offset < ((Number) a.get("width")).intValue();
            offset++
          ) lastWriters.put(
            "mem:" + (((Number) a.get("address")).intValue() + offset),
            i + 1
          );
        }
      String key = e.get("pc") + ":" + e.get("nextPC");
      edges.merge(key, 1, Integer::sum);
      var ins = (Map<String, Object>) e.get("instruction");
      if (ins.get("flow").equals("call")) calls.add(
        obj(
          "step",
          i + 1,
          "instruction",
          ins,
          "return",
          ((Number) e.get("pc")).intValue() + (delay ? 8 : 4)
        )
      );
      if (
        ins.get("op").equals("jr") &&
        ins.get("basic").toString().matches(".*(\\$31|\\$ra).*") &&
        !calls.isEmpty()
      ) calls.remove(calls.size() - 1);
    }
    var loops = new ArrayList<Object>();
    for (var ins : instructions.values()) {
      if (
        !Set.of("branch", "jump").contains(ins.get("flow")) ||
        !ins.containsKey("target")
      ) continue;
      int header = ((Number) ins.get("target")).intValue(),
        branch = ((Number) ins.get("address")).intValue();
      if (header > branch) continue;
      var iterations = new ArrayList<Integer>();
      int backs = 0;
      for (int i = 0; i < history.position; i++) {
        var e = history.get(i).event;
        if (((Number) e.get("pc")).intValue() == header) iterations.add(i + 1);
        if (
          ((Number) e.get("pc")).intValue() == branch + (delay ? 4 : 0) &&
          ((Number) e.get("nextPC")).intValue() == header
        ) backs++;
      }
      loops.add(
        obj(
          "header",
          header,
          "branch",
          branch,
          "entries",
          iterations.size(),
          "backJumps",
          backs,
          "iterations",
          iterations
        )
      );
    }
    var result = obj(
      "loops",
      loops,
      "protocol",
      1,
      "sessionId",
      id,
      "programVersion",
      programVersion,
      "stateVersion",
      stateVersion,
      "step",
      history.position,
      "historyLength",
      history.size(),
      "historyLimit",
      100000,
      "status",
      status,
      "error",
      error,
      "stopReason",
      stopReason,
      "logs",
      new ArrayList<>(logs),
      "pc",
      RegisterFile.getProgramCounter(),
      "registers",
      regs,
      "memory",
      memory,
      "memoryBase",
      memoryBase,
      "last",
      history.position > 0 ? history.get(history.position - 1).event : null,
      "preview",
      program == null ? null : preview(),
      "trace",
      recent,
      "lastWriters",
      lastWriters,
      "edges",
      edges,
      "calls",
      calls,
      "output",
      VirtualIO.current == null ? "" : VirtualIO.current.output,
      "handles",
      VirtualIO.current == null ? List.of() : VirtualIO.current.describe(),
      "inputCursor",
      VirtualIO.current == null ? 0 : VirtualIO.current.cursor,
      "inputEchoes",
      inputEchoes(),
      "pcVisits",
      executed.getOrDefault(RegisterFile.getProgramCounter(), 0) + 1,
      "exitCode",
      Globals.exitCode,
      "delay",
      delay,
      "diagnostics",
      diagnostics
    );
    if (program != null && lookaheadLines > 0) result.put(
      "lookahead",
      lookahead(lookaheadLines)
    );
    if (includeProgram) {
      result.put("instructions", instructions.values());
      result.put("symbols", symbols);
      result.put("files", sources);
      var docs = new LinkedHashMap<String, Object>();
      for (Object x : Globals.instructionSet.getInstructionList()) {
        Instruction ins = (Instruction) x;
        docs.putIfAbsent(
          ins.getName(),
          obj(
            "example",
            ins.getExampleFormat(),
            "description",
            ins.getDescription()
          )
        );
      }
      result.put("instructionDocs", docs);
    }
    return result;
  }
}
