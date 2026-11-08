package mars.browser;

/** Yield the Worker event loop while keeping the original Java stack and step-over depth. */
public final class Cooperate {

  public static boolean cancelled;
  private static long lastYield;

  public static void checkpoint() throws InterruptedException {
    long now = System.currentTimeMillis();
    if (now - lastYield >= 8) {
      Thread.sleep(1);
      lastYield = System.currentTimeMillis();
    }
  }
}
