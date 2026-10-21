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
        if (path.equals("/api")) {
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
          byte[] bytes = ex.getRequestBody().readNBytes(2_000_001);
          if (bytes.length > 2_000_000) throw new IllegalArgumentException(
            "Request limit 2 MB"
          );
          var req = (Map<String, Object>) Json.parse(
            new String(bytes, StandardCharsets.UTF_8)
          );
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
              examples.add(
                Json.obj(
                  "name",
                  dir.getFileName().toString(),
                  "files",
                  files,
                  "data",
                  data,
                  "entry",
                  "main.s"
                )
              );
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
          ? "text/javascript"
          : path.endsWith(".css")
            ? "text/css"
            : "text/html";
        send(ex, 200, Files.readString(p), type);
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
    server.start();
    System.out.println("MARS Teaching IDE http://127.0.0.1:" + port);
  }

  private static void send(HttpExchange ex, int code, String body, String type)
    throws java.io.IOException {
    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
    ex.getResponseHeaders().set("Content-Type", type + "; charset=utf-8");
    ex.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
    ex.getResponseHeaders().set("Cache-Control", "no-store");
    ex.sendResponseHeaders(code, bytes.length);
    ex.getResponseBody().write(bytes);
  }
}
