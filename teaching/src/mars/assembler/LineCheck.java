package mars.assembler;

import java.util.*;
import java.util.regex.*;
import mars.ErrorList;
import mars.ErrorMessage;
import mars.Globals;
import mars.mips.instructions.Instruction;

/**
 * Checks single source lines with the tokenizer and operand rules the
 * assembler uses, without assembling. Lives in this package for those rules.
 * It only says what one line can show: a line whose meaning depends on the
 * rest of the program (.eqv names, macros, data, directives) is undetermined,
 * never an error, and the full check answers for it.
 */
public final class LineCheck {

  public record Problem(int line, int column, String message) {}

  public record Result(List<Problem> problems, List<Integer> undetermined) {}

  private static final Pattern EQV = Pattern.compile("^\\s*\\.eqv\\s+(\\S+)");
  private static final Pattern MACRO = Pattern.compile("^\\s*\\.macro\\s+(\\S+)");
  private static final Pattern WORD = Pattern.compile("^\\s*(?:[\\w.$]+\\s*:\\s*)*(\\.\\w+)");

  private LineCheck() {}

  public static Result check(String text, Collection<Integer> lines) {
    String[] source = text.split("\n", -1);
    var eqv = new HashSet<String>();
    var macros = new HashSet<String>();
    // Lines that hold data or a macro body, or that are directives.
    var contextual = new boolean[source.length];
    boolean data = false, macro = false;
    for (int i = 0; i < source.length; i++) {
      String code = source[i].replaceFirst("#.*", "");
      Matcher m = EQV.matcher(code);
      if (m.find()) eqv.add(m.group(1));
      m = MACRO.matcher(code);
      if (m.find()) macros.add(m.group(1));
      m = WORD.matcher(code);
      String directive = m.find() ? m.group(1) : "";
      if (directive.equals(".data") || directive.equals(".kdata")) data = true;
      if (directive.equals(".text") || directive.equals(".ktext")) data = false;
      if (directive.equals(".macro")) macro = true;
      contextual[i] = data || macro || !directive.isEmpty();
      if (directive.equals(".end_macro")) macro = false;
    }
    var problems = new ArrayList<Problem>();
    var undetermined = new ArrayList<Integer>();
    for (int n : new TreeSet<>(lines)) {
      if (n < 1 || n > source.length) continue;
      if (contextual[n - 1]) {
        undetermined.add(n);
        continue;
      }
      var errors = new ErrorList();
      TokenList tokens = new Tokenizer().tokenizeLine(n, source[n - 1], errors, false);
      if (!errors.errorsOccurred()) tokens = operation(tokens);
      if (!errors.errorsOccurred() && !tokens.isEmpty()) {
        boolean known = true;
        for (int i = 0; i < tokens.size(); i++) if (eqv.contains(tokens.get(i).getValue())) known = false;
        if (macros.contains(tokens.get(0).getValue())) known = false;
        if (!known) {
          undetermined.add(n);
          continue;
        }
        operands(tokens, n, errors);
      }
      if (errors.errorsOccurred()) {
        var e = (ErrorMessage) errors.getErrorMessages().get(0);
        problems.add(new Problem(n, e.getPosition(), e.getMessage()));
      }
    }
    return new Result(problems, undetermined);
  }

  private static TokenList operation(TokenList tokens) {
    if (tokens.size() > 0 && tokens.get(tokens.size() - 1).getType() == TokenTypes.COMMENT) tokens.remove(tokens.size() - 1);
    while (
      tokens.size() > 1 &&
      (tokens.get(0).getType() == TokenTypes.IDENTIFIER || tokens.get(0).getType() == TokenTypes.OPERATOR) &&
      tokens.get(1).getType() == TokenTypes.COLON
    ) {
      tokens.remove(0);
      tokens.remove(0);
    }
    return tokens;
  }

  private static void operands(TokenList tokens, int line, ErrorList errors) {
    Token first = tokens.get(0);
    ArrayList<?> matches = first.getType() == TokenTypes.OPERATOR ? Globals.instructionSet.matchOperator(first.getValue()) : null;
    if (matches == null) {
      errors.add(new ErrorMessage("", line, first.getStartPos(), "\"" + first.getValue() + "\" is not a recognized operator"));
      return;
    }
    Instruction instruction = OperandFormat.bestOperandMatch(tokens, matches);
    OperandFormat.tokenOperandMatch(tokens, instruction, errors);
  }
}
