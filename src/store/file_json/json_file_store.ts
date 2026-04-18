import fs from 'node:fs';
import path from 'node:path';

export class JsonFileStore<T> {
  constructor(filePath: string, emptyValue: T) {
    this.filePath = filePath;
    this.emptyValue = emptyValue;
    this.ensureInitialized();
  }

  filePath: string;
  emptyValue: T;

  read(): T {
    this.ensureInitialized();
    return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
  }

  write(value: T) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return value;
  }

  ensureInitialized() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      this.write(this.emptyValue);
    }
  }
}
