package mars.ide;

import java.io.*;
import java.util.*;

/** JSON-lines transport for integration tests and desktop hosts. */
public final class Stdio {

  public static void main(String[] args) throws Exception {
    var session = new DebugSession();
    try (var r = new BufferedReader(new InputStreamReader(System.in))) {
      for (String line; (line = r.readLine()) != null; ) {
        try {
          System.out.println(
            Json.stringify(
              session.command((Map<String, Object>) Json.parse(line))
            )
          );
        } catch (Exception e) {
          System.out.println(Json.stringify(Json.obj("error", e.toString())));
        }
      }
    }
  }
}
