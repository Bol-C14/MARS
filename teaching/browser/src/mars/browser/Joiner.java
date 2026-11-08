package mars.browser;

public class Joiner {

  private final StringBuilder out;
  private final String delimiter, suffix;
  private boolean first = true;

  public Joiner(String d, String p, String s) {
    out = new StringBuilder(p);
    delimiter = d;
    suffix = s;
  }

  public Joiner add(String s) {
    if (!first) out.append(delimiter);
    first = false;
    out.append(s);
    return this;
  }

  public String toString() {
    return out.toString() + suffix;
  }
}
