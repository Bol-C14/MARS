package mars.browser;

public final class Hex {

  public static String format(byte[] bytes) {
    StringBuilder s = new StringBuilder();
    for (byte b : bytes) {
      s.append("0123456789abcdef".charAt((b & 255) >>> 4));
      s.append("0123456789abcdef".charAt(b & 15));
    }
    return s.toString();
  }
}
