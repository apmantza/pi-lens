// Tool-smoke fixture for #209 — dotnet build flags the type error (CS0029:
// cannot implicitly convert string to int).
class Program
{
    static void Main()
    {
        int x = "not a number";
        System.Console.WriteLine(x);
    }
}
