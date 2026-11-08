package mars.util;

import mars.ide.VirtualIO;

public class SystemIO {

  public static String fileErrorString = "File operation OK";

  public static int readInteger(int n) {
    return Integer.parseInt(VirtualIO.current.input().trim());
  }

  public static float readFloat(int n) {
    return Float.parseFloat(VirtualIO.current.input().trim());
  }

  public static double readDouble(int n) {
    return Double.parseDouble(VirtualIO.current.input().trim());
  }

  public static String readString(int n, int max) {
    return VirtualIO.current.inputString(max);
  }

  public static int readChar(int n) {
    return (VirtualIO.current.input() + "\n").charAt(0);
  }

  public static void printString(String s) {
    VirtualIO.current.print(s);
  }

  public static int openFile(String s, int f) {
    return VirtualIO.current.open(s, f);
  }

  public static int readFromFile(int f, byte[] b, int n) {
    return VirtualIO.current.read(f, b, n);
  }

  public static int writeToFile(int f, byte[] b, int n) {
    return VirtualIO.current.write(f, b, n);
  }

  public static void closeFile(int f) {
    VirtualIO.current.close(f);
  }

  public static void resetFiles() {}

  public static String getFileErrorMessage() {
    return fileErrorString;
  }
}
