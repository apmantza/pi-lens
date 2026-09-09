// Single source of truth for the #1718/#1728 hardcoded-machine-path shape,
// shared by tests/scripts/no-hardcoded-machine-paths.test.ts (source scan)
// and tests/packaging.test.ts's built dist/index.js artifact guard
// (#2594 review F2) so the two never drift into checking different patterns.
//
// A user-profile absolute path literal, any of:
//   - a Windows drive letter (any letter, not just C:) followed by \Users\
//     or /Users/ -- e.g. C:\Users\name, C:/Users/name, D:\Users\name
//   - a POSIX home directory -- /home/name (Linux) or /Users/name (macOS)
// Case-insensitive throughout (NTFS/APFS are case-insensitive by default,
// and a literal could be typed "c:/users/..." or "C:\USERS\...").
// Deliberately NOT anchored to any one username or OS -- the defect shape
// is "baked-in machine path", not "baked-in R3LiC on Windows".
export const USER_PROFILE_PATH_RE =
	/(?:[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9_.-]+|\/(?:home|Users)\/[A-Za-z0-9_.-]+)/gi;
