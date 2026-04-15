import fs from 'node:fs';
import path from 'node:path';

export class JsonFileStore {
  constructor(filePath, emptyValue) {
    this.filePath = filePath;
    this.emptyValue = emptyValue;
    this.ensureInitialized();
  }

  read() {
    this.ensureInitialized();
    return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
  }

  write(value) {
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
