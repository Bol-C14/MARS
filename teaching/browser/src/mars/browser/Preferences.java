package mars.browser;

public final class Preferences {

  private final java.util.Map<String, String> values =
    new java.util.HashMap<>();

  public static Preferences userNodeForPackage(Class<?> c) {
    return new Preferences();
  }

  public String get(String k, String fallback) {
    return values.getOrDefault(k, fallback);
  }

  public boolean getBoolean(String k, boolean fallback) {
    return Boolean.parseBoolean(get(k, "" + fallback));
  }

  public void put(String k, String v) {
    values.put(k, v);
  }

  public void putBoolean(String k, boolean v) {
    put(k, "" + v);
  }

  public void flush() throws java.util.prefs.BackingStoreException {}
}
