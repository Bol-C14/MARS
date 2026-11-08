package mars.ide;

import java.nio.file.*;
import java.util.Map;
import org.teavm.jso.*;

/** One complete MARS runtime per Worker. Messages use the existing JSON protocol. */
public final class BrowserKernel {

  private static DebugSession session;

  @JSFunctor
  interface Receiver extends JSObject {
    void receive(String message);
  }

  @JSBody(
    params = "receiver",
    script = "globalThis.marsReceive = receiver; globalThis.postMessage({ready:true});"
  )
  private static native void listen(Receiver receiver);

  @JSBody(
    params = "message",
    script = "globalThis.postMessage(JSON.parse(message));"
  )
  private static native void reply(String message);

  public static void main(String[] args) throws Exception {
    Files.createDirectories(Path.of("/tmp"));
    mars.Globals.initialize(false);
    listen(message -> {
      var envelope = (Map<String, Object>) Json.parse(message);
      if (Boolean.TRUE.equals(envelope.get("pause"))) {
        mars.browser.Cooperate.cancelled = true;
        return;
      }
      new Thread(() -> process(envelope)).start();
    });
  }

  @SuppressWarnings("unchecked")
  private static void process(Map<String, Object> envelope) {
    Object id = envelope.get("id");
    try {
      mars.browser.Cooperate.cancelled = false;
      Object result;
      if (Boolean.TRUE.equals(envelope.get("check"))) {
        result = Checker.respond(Json.stringify(envelope.get("body")));
      } else {
        if (session == null) session = new DebugSession();
        result = session.command((Map<String, Object>) envelope.get("body"));
      }
      reply(Json.stringify(Json.obj("id", id, "result", result)));
    } catch (Throwable e) {
      reply(Json.stringify(Json.obj("id", id, "error", e.toString())));
    }
  }
}
