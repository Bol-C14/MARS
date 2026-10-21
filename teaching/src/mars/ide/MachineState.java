package mars.ide;

import java.util.*;
import mars.Globals;
import mars.mips.hardware.*;
import mars.simulator.DelayedBranch;

/** Register/control/I/O checkpoint. Memory is stored as ordered access deltas in the trace. */
final class MachineState {

  final int[] gpr, cp0, cp1, branch;
  final int flags, heap, exit;
  final VirtualIO io;
  final String status, error;

  private MachineState(String status, String error) {
    this.status = status;
    this.error = error;
    gpr = new int[35];
    for (int i = 0; i < 32; i++) gpr[i] = RegisterFile.getRegisters()[
      i
    ].getValueNoNotify();
    gpr[32] = RegisterFile.getProgramCounter();
    gpr[33] = RegisterFile.getValue(33);
    gpr[34] = RegisterFile.getValue(34);
    cp0 = values(Coprocessor0.getRegisters());
    cp1 = values(Coprocessor1.getRegisters());
    flags = Coprocessor1.getConditionFlags();
    heap = Memory.heapAddress;
    branch = DelayedBranch.checkpoint();
    exit = Globals.exitCode;
    io = VirtualIO.current.copy();
  }

  private static int[] values(Register[] rs) {
    return Arrays.stream(rs).mapToInt(Register::getValueNoNotify).toArray();
  }

  static MachineState capture(String status, String error) {
    return new MachineState(status, error);
  }

  void restore() {
    for (int i = 0; i < 32; i++) RegisterFile.getRegisters()[i].setValue(
      gpr[i]
    );
    RegisterFile.initializeProgramCounter(gpr[32]);
    RegisterFile.updateRegister(33, gpr[33]);
    RegisterFile.updateRegister(34, gpr[34]);
    for (int i = 0; i < cp0.length; i++) Coprocessor0.getRegisters()[
      i
    ].setValue(cp0[i]);
    for (int i = 0; i < cp1.length; i++) Coprocessor1.getRegisters()[
      i
    ].setValue(cp1[i]);
    Coprocessor1.clearConditionFlags();
    for (int i = 0; i < 8; i++) if (
      (flags & (1 << i)) != 0
    ) Coprocessor1.setConditionFlag(i);
    Memory.heapAddress = heap;
    DelayedBranch.restore(branch);
    Globals.exitCode = exit;
    VirtualIO.current = io.copy();
  }
}
