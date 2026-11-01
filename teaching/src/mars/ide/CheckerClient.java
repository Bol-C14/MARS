package mars.ide;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/**
 * The local service's link to its checker process. A check that hangs or a
 * checker that dies costs one "undetermined" reply and a restart; the debug
 * session is not involved.
 */
final class CheckerClient {

  private static final long TIMEOUT_SECONDS = 5;
  private final List<String> command;
  private Process process;
  private BufferedReader replies;
  private BufferedWriter requests;

  CheckerClient() {
    String custom = System.getenv("MARS_CHECKER_COMMAND");
    String java = ProcessHandle.current().info().command().orElse("java");
    command = custom != null
      ? List.of(custom.split(" "))
      : List.of(java, "-Djava.awt.headless=true", "-cp", System.getProperty("java.class.path"), "mars.ide.Checker");
    Runtime.getRuntime().addShutdownHook(new Thread(this::stop));
  }

  private void start() throws IOException {
    process = new ProcessBuilder(command).redirectError(ProcessBuilder.Redirect.DISCARD).start();
    replies = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
    requests = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
  }

  private synchronized void stop() {
    if (process != null) process.destroyForcibly();
    process = null;
  }

  synchronized String call(Map<String, Object> request) {
    try {
      if (process == null || !process.isAlive()) start();
      requests.write(Json.stringify(request));
      requests.newLine();
      requests.flush();
      BufferedReader reader = replies;
      String reply = CompletableFuture
        .supplyAsync(() -> {
          try {
            return reader.readLine();
          } catch (IOException e) {
            return null;
          }
        })
        .get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
      if (reply != null) return reply;
    } catch (IOException | InterruptedException | ExecutionException | TimeoutException e) {
      // Falls through to the restart.
    }
    stop();
    return Json.stringify(
      Json.obj(
        "protocol", Checker.PROTOCOL, "id", request.get("id"), "status", "undetermined",
        "diagnostics", List.of(), "undetermined", List.of(), "reason", "Checker restarted"
      )
    );
  }
}
