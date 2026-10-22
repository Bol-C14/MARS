package mars.ide;

import java.nio.charset.StandardCharsets;
import java.util.*;

/** Session-owned I/O. No simulated program can open a host file through this adapter. */
public final class VirtualIO {

  public static volatile VirtualIO current;

  public static final class NeedsInput extends RuntimeException {}

  public Map<String, byte[]> files = new LinkedHashMap<>();
  public List<String> inputs = new ArrayList<>();
  public int cursor = 0;
  public String output = "";
  /** Output length at the moment each input was consumed (for echoing it); replaced, never mutated. */
  public List<Integer> echoAt = List.of();
  private Map<Integer, Handle> handles = new LinkedHashMap<>();

  private record Handle(String name, int flags, int position) {}

  public VirtualIO copy() {
    var v = new VirtualIO();
    v.files = new LinkedHashMap<>(files);
    v.inputs = inputs;
    v.cursor = cursor;
    v.output = output;
    v.echoAt = echoAt;
    v.handles = new LinkedHashMap<>(handles);
    return v;
  }

  public String input() {
    if (cursor >= inputs.size()) throw new NeedsInput();
    var at = new ArrayList<>(echoAt);
    at.add(output.length());
    echoAt = List.copyOf(at);
    return inputs.get(cursor++);
  }

  public String inputString(int max) {
    String s = input();
    return s.substring(0, Math.min(s.length(), Math.max(0, max)));
  }

  public void print(String s) {
    if (
      output.length() + s.length() > 1_000_000
    ) throw new IllegalStateException("Console limit: 1 MB");
    output += s;
  }

  public int open(String name, int flags) {
    if (!Set.of(0, 1, 9).contains(flags)) return -1;
    if (flags == 0 && !files.containsKey(name)) return -1;
    int fd = 3;
    while (handles.containsKey(fd)) fd++;
    if (fd >= 32) return -1;
    if (flags == 1 || !files.containsKey(name)) files.put(name, new byte[0]);
    handles.put(
      fd,
      new Handle(name, flags, flags == 9 ? files.get(name).length : 0)
    );
    return fd;
  }

  public int read(int fd, byte[] target, int n) {
    if (fd == 0) {
      byte[] data = input().getBytes(StandardCharsets.UTF_8);
      int count = Math.min(n, data.length);
      System.arraycopy(data, 0, target, 0, count);
      return count;
    }
    var h = handles.get(fd);
    if (h == null || h.flags != 0 || n < 0) return -1;
    byte[] data = files.get(h.name);
    int count = Math.min(n, data.length - h.position);
    System.arraycopy(data, h.position, target, 0, count);
    handles.put(fd, new Handle(h.name, h.flags, h.position + count));
    return count;
  }

  public int write(int fd, byte[] data, int n) {
    if (n < 0 || n > data.length) return -1;
    if (fd == 1 || fd == 2) {
      print(new String(data, 0, n, StandardCharsets.UTF_8));
      return n;
    }
    var h = handles.get(fd);
    if (h == null || h.flags == 0) return -1;
    if (h.position + n > 1_000_000) throw new IllegalStateException(
      "Virtual file limit: 1 MB"
    );
    byte[] next = Arrays.copyOf(
      files.get(h.name),
      Math.max(files.get(h.name).length, h.position + n)
    );
    System.arraycopy(data, 0, next, h.position, n);
    files.put(h.name, next);
    handles.put(fd, new Handle(h.name, h.flags, h.position + n));
    return n;
  }

  public void close(int fd) {
    handles.remove(fd);
  }

  public List<Object> describe() {
    var out = new ArrayList<Object>();
    handles.forEach((fd, h) ->
      out.add(
        Json.obj(
          "fd",
          fd,
          "name",
          h.name,
          "position",
          h.position,
          "flags",
          h.flags
        )
      )
    );
    return out;
  }
}
