---
section: Fixed
audience: user
---

- **csharp-ls no longer crashes with SIGABRT in C# folders that have no solution or project** — for a C# file with no `.sln`/`.slnx`/`.csproj` above it (a Unity `Assets/**` tree is the common case), the root fallback handed csharp-ls the file's own directory. csharp-ls then threw "no .csproj/.fsproj or sln files found" on a thread-pool thread and the .NET runtime aborted the process, leaving a core dump per attempt. pi-lens now declines to start csharp-ls when no solution or project file exists at the file's root or in a bounded search below it (at most 128 directories, nearest first). `lsp_diagnostics` then reports the file as unconfirmed and names the missing project root and the search bound instead of a start problem. The OmniSharp fallback server is unchanged. The dotnet test runner and the `dotnet build` runner now read the same project-file rule, so a directory or backup file named like a project (`Foo.csproj/`, `Foo.csproj.bak`) no longer counts as one.
