// Tool-smoke fixture for #209 — javac flags the incompatible-types assignment.
public class Bad {
    public static void main(String[] args) {
        int x = "not a number";
        System.out.println(x);
    }
}
