import mars.*;import mars.mips.hardware.*;import java.util.*;import java.io.*;
/** Compiled against the unmodified upstream tree, independent of the teaching adapter. */
public class UpstreamProbe {
 public static void main(String[] args)throws Exception{
  Globals.initialize(false);Globals.getSettings().setBooleanSettingNonPersistent(Settings.DELAYED_BRANCHING_ENABLED,Boolean.parseBoolean(args[0]));Globals.program=new MIPSprogram();var files=new ArrayList<String>();for(int i=1;i<args.length;i++)files.add(args[i]);var prepared=Globals.program.prepareFilesForAssembly(files,args[1],null);Globals.program.assemble(prepared,true,false);RegisterFile.initializeProgramCounter(true);
  var realOut=System.out;var output=new ByteArrayOutputStream();System.setOut(new PrintStream(output));System.setIn(new ByteArrayInputStream("898\n".getBytes()));
  for(int step=0;step<300;step++){
   if(step>0&&Globals.program.simulateStepAtPC(null)){emit(realOut,output,step);break;}emit(realOut,output,step);
  }
 }
 static void emit(PrintStream out,ByteArrayOutputStream output,int step)throws Exception{var nums=new ArrayList<Integer>();for(Register r:RegisterFile.getRegisters())nums.add(r.getValueNoNotify());var mem=new ArrayList<Integer>();for(int i=0;i<128;i++)mem.add(Globals.memory.getByte(0x10010000+i));for(int i=0;i<32;i++)mem.add(Globals.memory.getByte(0x7fffefe0+i));out.println("{\"step\":"+step+",\"pc\":"+RegisterFile.getProgramCounter()+",\"registers\":"+nums+",\"memory\":"+mem+",\"output64\":\""+Base64.getEncoder().encodeToString(output.toByteArray())+"\"}");}
}
