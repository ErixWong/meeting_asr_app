declare module "node:sqlite" {
  type SqliteRow = Record<string, unknown>;

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare<T = SqliteRow>(sql: string): {
      run: (...params: unknown[]) => { changes?: number; lastInsertRowid?: number };
      get: <U = T>(...params: unknown[]) => U | undefined;
      all: <U = T>(...params: unknown[]) => U[];
    };
  }
}
