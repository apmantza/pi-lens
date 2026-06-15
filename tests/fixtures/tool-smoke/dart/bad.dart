// Tool-smoke fixture for #209 — dart analyze flags the incompatible assignment.
void main() {
  int x = 'not a number';
  print(x);
}
