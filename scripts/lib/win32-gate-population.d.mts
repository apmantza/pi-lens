export interface Win32Gate {
	file: string;
	line: number;
}

export declare function findWin32Gates(cwd?: string): Win32Gate[];
export declare function getWin32GateFiles(cwd?: string): string[];
export declare function getWin32LaneFiles(cwd?: string): string[];
