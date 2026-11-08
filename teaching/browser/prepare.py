"""Generate the browser platform overlay; MIPS assembly and instruction semantics stay upstream."""
from pathlib import Path
import json, re, shutil
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'teaching/build/browser/src'
OUT.mkdir(parents=True, exist_ok=True)
def write(path, text):
    p = OUT / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
def adapt(path, transform):
    write(path, transform((ROOT / path).read_text()))
# Resources are resolved at build time, not with reflection at runtime.
resources = {('/' + p.name): p.read_text() for p in ROOT.iterdir() if p.suffix in ('.txt', '.properties')}
write('mars/browser/Resources.java', '''package mars.browser;
public final class Resources {
 public static java.io.InputStream open(String name) {
 String text = switch(name) {\n''' + '\n'.join('case '+json.dumps(k)+' -> '+'new StringBuilder()'+''.join('.append('+json.dumps(v[i:i+8000], ensure_ascii=True)+')' for i in range(0,len(v),8000))+'.toString()'+';' for k,v in resources.items()) + '''
 default -> throw new IllegalArgumentException("Missing resource " + name);
 }; return new java.io.ByteArrayInputStream(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
 }}''')
adapt('mars/util/PropertiesFile.java', lambda s: s.replace('PropertiesFile.class.getResourceAsStream(', 'mars.browser.Resources.open('))
adapt('mars/mips/instructions/InstructionSet.java', lambda s: s.replace('this.getClass().getResourceAsStream(', 'mars.browser.Resources.open(').replace('System.exit(0);', 'throw new IllegalStateException("Cannot load MARS instructions");'))
# Preserve the original services used by the web IDE. Static registry replaces classpath scanning.
syscalls=[]
for p in (ROOT/'mars/mips/instructions/syscalls').glob('Syscall*.java'):
    m=re.search(r'super\(\s*(\d+)\s*,',p.read_text())
    if m and (1 <= int(m[1]) <= 17 or 34 <= int(m[1]) <= 36): syscalls.append(p.stem)
write('mars/mips/instructions/SyscallLoader.java', '''package mars.mips.instructions;
import mars.mips.instructions.syscalls.*;
class SyscallLoader {
 private Syscall[] syscalls;
 void loadSyscalls() { syscalls = new Syscall[] {''' + ','.join('new '+s+'()' for s in sorted(syscalls)) + '''}; }
 Syscall findSyscall(int number) { if(syscalls==null)loadSyscalls(); for(Syscall s:syscalls)if(s.getNumber()==number)return s; return null; }
}''')
# Generate a synchronous adapter from the very same execution loop, never a second interpreter.
simulator=(ROOT/'mars/simulator/Simulator.java').read_text()
body=simulator.split('public Object construct() {',1)[1].split('public void finished()',1)[0]
body=body[:body.rfind('}')].rstrip() # strip method close, leaving comments is harmless
body=body.replace('Thread.currentThread().setPriority(Thread.NORM_PRIORITY-1);','').replace('Thread.yield();','')
start=body.index('               //if (Globals.getGui()')
end=body.index('               // Get next instruction',start)
body=body[:start]+body[end:]
write('mars/simulator/Simulator.java', '''package mars.simulator;
import mars.*; import mars.util.*; import mars.mips.hardware.*; import mars.mips.instructions.*; import java.util.*;
public class Simulator extends Observable {
 public static final int NO_DEVICE=0, BREAKPOINT=1, EXCEPTION=2, MAX_STEPS=3, NORMAL_TERMINATION=4, CLIFF_TERMINATION=5, PAUSE_OR_STOP=6;
 public static volatile int externalInterruptingDevice=NO_DEVICE;
 private static final Simulator INSTANCE=new Simulator();
 public static Simulator getInstance(){return INSTANCE;}
 public static boolean inDelaySlot(){return DelayedBranch.isTriggered();}
 public boolean simulate(MIPSprogram p,int pc,int maxSteps,int[] breakPoints,javax.swing.AbstractAction actor) throws ProcessingException {
  Step step=new Step(p,pc,maxSteps,breakPoints); step.construct(); if(step.pe!=null)throw step.pe; return step.done;
 }
 private void notifyObserversOfExecutionStart(int maxSteps,int pc){}
 private void notifyObserversOfExecutionStop(int maxSteps,int pc){}
 class Step {
  MIPSprogram p; int pc,maxSteps; int[] breakPoints; boolean done,stop; ProcessingException pe; int constructReturnReason;
  Step(MIPSprogram p,int pc,int maxSteps,int[] bp){this.p=p;this.pc=pc;this.maxSteps=maxSteps;this.breakPoints=bp;}
  public Object construct() {''' + body + '\n}\n}\n}')
adapt('teaching/src/mars/ide/Json.java',lambda s:s.replace('StringJoiner','mars.browser.Joiner'))
# Java 17 conveniences with equivalent TeaVM-supported implementations.
adapt('teaching/src/mars/ide/DebugSession.java',lambda s:s.replace('HexFormat.of().formatHex(', 'mars.browser.Hex.format(').replace('var out = new StringBuilder();\n    while (m.find())', 'var out = new StringBuffer();\n    while (m.find())'))
# adapt() retains repo path; move teaching sources to their package path.
for p in list((OUT/'teaching/src').rglob('*.java')):
    dest=OUT/p.relative_to(OUT/'teaching/src');dest.parent.mkdir(parents=True,exist_ok=True);shutil.move(p,dest)
shutil.rmtree(OUT/'teaching',ignore_errors=True)
adapt('mars/Settings.java', lambda s: s.replace('import java.util.prefs.*;', 'import mars.browser.Preferences;\nimport java.util.prefs.BackingStoreException;').replace('         initializeEditorSyntaxStyles();','').replace('         getEditorSyntaxStyleSettingsFromPreferences();',''))
# SHA-256 is an opaque content identity in the protocol; keep byte-for-byte parity with the JVM.
p=OUT/'mars/ide/DebugSession.java'
p.write_text(p.read_text().replace('java.security.MessageDigest.getInstance("SHA-256").digest(bytes)', 'mars.browser.Sha256.digest(bytes)'))

# Expose the same checker protocol without the JVM stdin/stdout entry point.
adapt('teaching/src/mars/ide/Checker.java', lambda s: s.replace('private static Map<String, Object> respond(', 'public static Map<String, Object> respond('))
p=OUT/'teaching/src/mars/ide/Checker.java'
dest=OUT/'mars/ide/Checker.java';shutil.move(p,dest);shutil.rmtree(OUT/'teaching')
# Suspend the Java stack between small execution chunks: call depth, watches and
# breakpoint skip state remain local to run(), including step-over and step-out.
p=OUT/'mars/ide/DebugSession.java'
s=p.read_text().replace('for (int i = 0; i < limit; i++) {', 'for (int i = 0; i < limit; i++) {\n      mars.browser.Cooperate.checkpoint();\n      if (mars.browser.Cooperate.cancelled) { stopReason = "Paused"; return; }')
p.write_text(s)
shutil.copytree(ROOT/'teaching/browser/src', OUT, dirs_exist_ok=True)
