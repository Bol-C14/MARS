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
          // Each example is a folder with example.json (order, entry, titles)
          // and one complete copy per interface language (classroom
          // 2026-11-04): the same code, comments in that language.
          var examples = new ArrayList<Map<String, Object>>();
          Path root = Path.of("teaching/examples");
          try (var dirs = Files.list(root)) {
            for (var dir : dirs.filter(Files::isDirectory).sorted().toList()) {
              Path meta = dir.resolve("example.json");
              if (!Files.isRegularFile(meta)) continue;
              var example = (Map<String, Object>) Json.parse(Files.readString(meta));
              example.put("name", dir.getFileName().toString());
              var languages = new LinkedHashMap<String, Object>();
              try (var langs = Files.list(dir)) {
                for (var lang : langs.filter(Files::isDirectory).sorted().toList()) {
                  var files = new LinkedHashMap<String, String>();
                  var data = new LinkedHashMap<String, String>();
                  try (var entries = Files.list(lang)) {
                    for (var p : entries.filter(Files::isRegularFile).sorted().toList()) {
                      String name = p.getFileName().toString();
                      if (name.endsWith(".s") || name.endsWith(".asm")) files.put(name, Files.readString(p));
                      else if (!name.startsWith(".")) data.put(name, Files.readString(p));
                    }
                  }
                  languages.put(lang.getFileName().toString(), Json.obj("files", files, "data", data));
                }
              }
              example.put("languages", languages);
              examples.add(example);
            }
          }
          examples.sort(Comparator.comparingInt((Map<String, Object> e) -> e.get("order") instanceof Number n ? n.intValue() : 0));
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
