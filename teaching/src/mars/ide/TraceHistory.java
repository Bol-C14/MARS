package mars.ide;

import java.util.*;

/** Bounded, branchable execution history. Cursor always denotes a post-step state. */
final class TraceHistory<E> {

  private final List<E> entries = new ArrayList<>();
  int position = 0;
  static final int LIMIT = 100000;

  interface Apply<E> {
    void apply(E entry, boolean forward) throws Exception;
  }

  int size() {
    return entries.size();
  }

  E get(int i) {
    return entries.get(i);
  }

  void clear() {
    entries.clear();
    position = 0;
  }

  boolean full() {
    return position >= LIMIT;
  }

  void append(E entry) {
    while (entries.size() > position) entries.remove(entries.size() - 1);
    entries.add(entry);
    position++;
  }

  void seek(int target, Apply<E> apply) throws Exception {
    if (
      target < 0 || target > entries.size()
    ) throw new IllegalArgumentException("Invalid history step");
    while (position > target) {
      E e = entries.get(position - 1);
      apply.apply(e, false);
      position--;
    }
    while (position < target) {
      E e = entries.get(position);
      apply.apply(e, true);
      position++;
    }
  }
}
