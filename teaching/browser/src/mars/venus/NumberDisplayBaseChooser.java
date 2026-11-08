package mars.venus;

public class NumberDisplayBaseChooser {

  public static final int HEXADECIMAL = 16,
    DECIMAL = 10;

  public static String formatUnsignedInteger(int value, int base) {
    return base == 16
      ? mars.util.Binary.intToHexString(value)
      : Long.toString(Integer.toUnsignedLong(value));
  }

  public static String formatNumber(int value, int base) {
    return base == 16
      ? mars.util.Binary.intToHexString(value)
      : Integer.toString(value);
  }
}
