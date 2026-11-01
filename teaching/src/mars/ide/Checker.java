package mars.ide;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import mars.Globals;
import mars.assembler.LineCheck;

/**
 * Syntax checks for code being typed, shared by every student. JSON lines on
 * stdin and stdout, one request at a time; docs/CHECKER-PROTOCOL.md has the
 * contract. Assembling clears MARS's global memory and symbol table, so this
 * runs in a process of its own and never inside a debug session.
 */
public final class Checker {

  static final int PROTOCOL = 1;

  private Checker() {}

  public static void main(String[] args) throws Exception {
    var out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
    // MARS may print while assembling; only replies go to the real stdout.
    System.setOut(System.err);
    Globals.initialize(false);
    try (var r = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
      for (String line; (line = r.readLine()) != null; ) out.println(Json.stringify(respond(line)));
    }
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> respond(String line) {
    Object id = null;
    try {
      var request = (Map<String, Object>) Json.parse(line);
      id = request.get("id");
      String command = String.valueOf(request.get("command"));
      if (command.equals("line")) return line(request, id);
      if (command.equals("full")) return full(request, id);
      return undetermined(id, "Unknown command " + command);
    } catch (Exception e) {
      return undetermined(id, e.toString());
    }
  }

  private static Map<String, Object> reply(Object id, String status, Object diagnostics, Object undetermined) {
    return Json.obj("protocol", PROTOCOL, "id", id, "status", status, "diagnostics", diagnostics, "undetermined", undetermined);
  }

  /** Nothing is known about this request; the client keeps what it shows. */
  private static Map<String, Object> undetermined(Object id, String reason) {
    var r = reply(id, "undetermined", List.of(), List.of());
    r.put("reason", reason);
    return r;
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> line(Map<String, Object> request, Object id) {
    String text = request.get("text").toString(), file = request.get("file").toString();
    if (text.length() > 1_000_000) return undetermined(id, "Source limit 1 MB");
    var lines = new ArrayList<Integer>();
    for (Object n : (List<Object>) request.get("lines")) lines.add(((Number) n).intValue());
    var result = LineCheck.check(text, lines);
    var diagnostics = new ArrayList<Object>();
    for (var p : result.problems()) diagnostics.add(
      Json.obj("file", file, "line", p.line(), "column", p.column(), "message", p.message(), "warning", false)
    );
    return reply(id, "ok", diagnostics, result.undetermined());
  }

  /**
   * A new session per check: its fields start empty, and assembling clears the
   * global memory and symbol table, so no program sees the one before it.
   */
  private static Map<String, Object> full(Map<String, Object> request, Object id) throws Exception {
    var session = new DebugSession();
    try {
      var state = session.assemble(request);
      return reply(id, "ok", state.get("diagnostics"), List.of());
    } catch (IllegalArgumentException e) {
      return undetermined(id, e.getMessage());
    } finally {
      session.removeProject();
    }
  }
}
