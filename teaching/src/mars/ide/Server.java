package mars.ide;

import com.sun.net.httpserver.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Loopback-only local IDE service. Same-origin JSON mutations; no host file API. */
public final class Server {

  public static void main(String[] args) throws Exception {
    int port = args.length > 0 ? Integer.parseInt(args[0]) : 8765;
    var session = new DebugSession();
    var checker = new CheckerClient();
    var server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
    server.createContext("/", ex -> {
      try {
        String path = ex.getRequestURI().getPath();
        String host = ex.getRequestHeaders().getFirst("Host");
        if (!Set.of("127.0.0.1:" + port, "localhost:" + port).contains(host)) {
          send(
            ex,
            403,
            Json.stringify(Json.obj("error", "Invalid host")),
            "application/json"
          );
          return;
        }
        if (path.equals("/api") || path.equals("/api/check")) {
          if (
            !ex.getRequestMethod().equals("POST") ||
            !Optional.ofNullable(
              ex.getRequestHeaders().getFirst("Content-Type")
            )
              .orElse("")
              .startsWith("application/json")
          ) {
            send(ex, 405, "{}", "application/json");
            return;
          }
          String origin = ex.getRequestHeaders().getFirst("Origin");
          if (origin != null && !origin.equals("http://" + host)) {
            send(ex, 403, "{}", "application/json");
            return;
          }
          byte[] bytes = ex.getRequestBody().readNBytes(8_000_001);
          if (bytes.length > 8_000_000) throw new IllegalArgumentException(
            "Request limit 8 MB"
          );
          var req = (Map<String, Object>) Json.parse(
            new String(bytes, StandardCharsets.UTF_8)
          );
          // Checks go to their own process, never to the debug session.
          if (path.equals("/api/check")) {
            send(ex, 200, checker.call(req), "application/json");
            return;
          }
          synchronized (session) {
            send(
              ex,
              200,
              Json.stringify(session.command(req)),
              "application/json"
            );
          }
          return;
        }
        if (path.equals("/examples")) {
          var examples = new ArrayList<Object>();
          Path root = Path.of("teaching/examples");
          try (var dirs = Files.list(root)) {
            for (var dir : dirs.filter(Files::isDirectory).sorted().toList()) {
              var files = new LinkedHashMap<String, String>();
              var data = new LinkedHashMap<String, String>();
              try (var entries = Files.list(dir)) {
                for (var p : entries
                  .filter(Files::isRegularFile)
                  .sorted()
                  .toList()) {
                  String name = p.getFileName().toString();
                  if (name.endsWith(".s")) files.put(name, Files.readString(p));
                  else if (name.endsWith(".txt")) data.put(
                    name,
                    Files.readString(p)
                  );
                }
              }
              // An example that needs several sources declares its joint
              // assembly in .mars-project.json; the rest assemble the file
              // being edited.
              var example = Json.obj(
                "name",
                dir.getFileName().toString(),
                "files",
                files,
                "data",
                data,
                "entry",
                "main.s"
              );
              Path meta = dir.resolve(".mars-project.json");
              if (Files.isRegularFile(meta)) {
                var declared = (Map<?, ?>) Json.parse(Files.readString(meta));
                for (String key : List.of("entry", "assembly"))
                  if (declared.containsKey(key)) example.put(
                    key,
                    declared.get(key)
                  );
              }
              examples.add(example);
            }
          }
          send(ex, 200, Json.stringify(examples), "application/json");
          return;
        }
        Path root = Path.of("teaching/web").toAbsolutePath().normalize();
        Path p = root
          .resolve(path.equals("/") ? "index.html" : path.substring(1))
          .normalize();
        if (!p.startsWith(root) || !Files.isRegularFile(p)) {
          send(ex, 404, "Not found", "text/plain");
          return;
        }
        String type = path.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : path.endsWith(".css")
            ? "text/css; charset=utf-8"
            : path.endsWith(".woff2")
              ? "font/woff2"
              : path.endsWith("LICENSE")
                ? "text/plain; charset=utf-8"
                : "text/html; charset=utf-8";
        send(ex, 200, Files.readAllBytes(p), type);
      } catch (Exception e) {
        send(
          ex,
          400,
          Json.stringify(
            Json.obj(
              "error",
              e.getMessage() == null ? e.toString() : e.getMessage()
            )
          ),
          "application/json"
        );
      } finally {
        ex.close();
      }
    });
    // A check waiting for the checker must not hold up debugging.
    server.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
    server.start();
    System.out.println("MARS Teaching IDE http://127.0.0.1:" + port);
  }

  private static void send(HttpExchange ex, int code, String body, String type)
    throws java.io.IOException {
    send(ex, code, body.getBytes(StandardCharsets.UTF_8), type + "; charset=utf-8");
  }

  /** Static files go out as stored: fonts are binary. */
  private static void send(HttpExchange ex, int code, byte[] bytes, String type)
    throws java.io.IOException {
    ex.getResponseHeaders().set("Content-Type", type);
    ex.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
    ex.getResponseHeaders().set("Cache-Control", "no-store");
    ex.sendResponseHeaders(code, bytes.length);
    ex.getResponseBody().write(bytes);
  }
}
