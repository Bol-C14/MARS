package mars.ide;

import java.util.*;

/** Small dependency-free JSON codec for the local versioned protocol. */
public final class Json {

  public static Map<String, Object> obj(Object... pairs) {
    var m = new LinkedHashMap<String, Object>();
    for (int i = 0; i < pairs.length; i += 2) m.put(
      (String) pairs[i],
      pairs[i + 1]
    );
    return m;
  }

  public static String stringify(Object v) {
    if (v == null) return "null";
    if (v instanceof String s) {
      var b = new StringBuilder("\"");
      for (char c : s.toCharArray())
        switch (c) {
          case '"' -> b.append("\\\"");
          case '\\' -> b.append("\\\\");
          case '\n' -> b.append("\\n");
          case '\r' -> b.append("\\r");
          case '\t' -> b.append("\\t");
          default -> {
            if (c < 32) b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
          }
        }
      return b.append('"').toString();
    }
    if (v instanceof Number || v instanceof Boolean) return v.toString();
    if (v instanceof Map<?, ?> m) {
      var j = new StringJoiner(",", "{", "}");
      m.forEach((k, x) -> j.add(stringify(k.toString()) + ":" + stringify(x)));
      return j.toString();
    }
    if (v instanceof Iterable<?> a) {
      var j = new StringJoiner(",", "[", "]");
      for (var x : a) j.add(stringify(x));
      return j.toString();
    }
    if (v.getClass().isArray()) {
      var j = new StringJoiner(",", "[", "]");
      for (int i = 0; i < java.lang.reflect.Array.getLength(v); i++) j.add(
        stringify(java.lang.reflect.Array.get(v, i))
      );
      return j.toString();
    }
    throw new IllegalArgumentException("Not JSON: " + v.getClass());
  }

  public static Object parse(String s) {
    var p = new Parser(s);
    Object v = p.value();
    p.ws();
    if (p.i != s.length()) throw new IllegalArgumentException("Trailing JSON");
    return v;
  }

  private static final class Parser {

    String s;
    int i;

    Parser(String s) {
      this.s = s;
    }

    void ws() {
      while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
    }

    char take() {
      return s.charAt(i++);
    }

    Object value() {
      ws();
      char c = take();
      if (c == '"') {
        var b = new StringBuilder();
        while (true) {
          char x = take();
          if (x == '"') return b.toString();
          if (x == '\\') {
            x = take();
            switch (x) {
              case 'n' -> b.append('\n');
              case 'r' -> b.append('\r');
              case 't' -> b.append('\t');
              case 'b' -> b.append('\b');
              case 'f' -> b.append('\f');
              case 'u' -> {
                b.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                i += 4;
              }
              default -> b.append(x);
            }
          } else b.append(x);
        }
      }
      if (c == '{' || c == '[') {
        boolean map = c == '{';
        var m = new LinkedHashMap<String, Object>();
        var a = new ArrayList<Object>();
        ws();
        if (s.charAt(i) == (map ? '}' : ']')) {
          i++;
          return map ? m : a;
        }
        while (true) {
          Object x = value();
          if (map) {
            ws();
            if (take() != ':') throw new IllegalArgumentException(
              "Expected colon"
            );
            m.put((String) x, value());
          } else a.add(x);
          ws();
          char end = take();
          if (end == (map ? '}' : ']')) return map ? m : a;
          if (end != ',') throw new IllegalArgumentException("Expected comma");
        }
      }
      int start = --i;
      while (i < s.length() && !",]} \n\r\t".contains("" + s.charAt(i))) i++;
      String token = s.substring(start, i);
      return switch (token) {
        case "null" -> null;
        case "true" -> true;
        case "false" -> false;
        default -> token.contains(".")
          ? Double.valueOf(token)
          : Long.valueOf(token);
      };
    }
  }
}
