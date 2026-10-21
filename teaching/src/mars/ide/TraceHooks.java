package mars.ide;

import java.util.*;
import mars.mips.hardware.Register;

/** Active only around real core execution, inherited by MARS's simulation thread. */
public final class TraceHooks {

  public static final InheritableThreadLocal<List<Map<String, Object>>> active =
    new InheritableThreadLocal<>();

  public static void register(
    Register r,
    boolean write,
    int before,
    int value
  ) {
    var list = active.get();
    if (list != null && !r.getName().equals("pc")) list.add(
      Json.obj(
        "kind",
        "register",
        "write",
        write,
        "name",
        r.getName(),
        "number",
        r.getNumber(),
        "before",
        before,
        "value",
        value
      )
    );
  }

  public static void memory(
    boolean write,
    int address,
    int width,
    int before,
    int value
  ) {
    var list = active.get();
    if (list != null) list.add(
      Json.obj(
        "kind",
        "memory",
        "write",
        write,
        "address",
        address,
        "width",
        width,
        "before",
        before,
        "value",
        value
      )
    );
  }
}
