import fs from "node:fs";
import path from "node:path";
import type { Blueprint, ProjectInfo } from "./shared/protocol.js";

/** Names we never surface as projects (incl. v6 multi-tenant infra dirs). */
const HIDDEN = new Set([".git", ".DS_Store", "node_modules", "users", ".ide-meta"]);

/** Validate a project name and resolve it safely under the projects root. */
export function resolveProject(projectsRoot: string, name: string): string {
  if (!/^[A-Za-z0-9 _-]{1,64}$/.test(name)) {
    throw new Error("Project name may only contain letters, numbers, spaces, - and _.");
  }
  const abs = path.resolve(projectsRoot, name);
  const root = path.resolve(projectsRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("Invalid project path.");
  }
  return abs;
}

export function listProjects(projectsRoot: string): ProjectInfo[] {
  fs.mkdirSync(projectsRoot, { recursive: true });
  const entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  const projects: ProjectInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || HIDDEN.has(entry.name)) continue;
    const abs = path.join(projectsRoot, entry.name);
    const stat = fs.statSync(abs);
    let entryCount = 0;
    try {
      entryCount = fs.readdirSync(abs).filter((n) => !HIDDEN.has(n)).length;
    } catch {
      /* ignore */
    }
    projects.push({ name: entry.name, lastModifiedMs: stat.mtimeMs, entryCount });
  }
  return projects.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
}

/** Blueprint = a set of seed files + an optional one-shot init command. */
interface BlueprintDef {
  files: Record<string, string>;
  /** Command run once after scaffolding (best-effort, streamed to terminal). */
  init?: string;
}

const BLUEPRINTS: Record<Blueprint, BlueprintDef> = {
  blank: {
    files: { "README.md": "# New Project\n\nAn empty canvas. Start building!\n" },
  },

  "react-vite": {
    files: {
      "package.json": JSON.stringify(
        {
          name: "react-vite-app",
          private: true,
          type: "module",
          scripts: { dev: "vite --host --port 3000", build: "vite build" },
          dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
          devDependencies: { vite: "^5.4.0", "@vitejs/plugin-react": "^4.3.1" },
        },
        null,
        2,
      ),
      "index.html":
        '<!doctype html>\n<html>\n  <head><meta charset="utf-8" /><title>React + Vite</title></head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n',
      "vite.config.js":
        "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n",
      "src/main.jsx":
        "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\ncreateRoot(document.getElementById('root')).render(<App />);\n",
      "src/App.jsx":
        "export default function App() {\n  return <h1 style={{ fontFamily: 'system-ui', padding: 40 }}>Hello from React + Vite 🚀</h1>;\n}\n",
    },
    init: "npm install",
  },

  python: {
    files: {
      "main.py":
        'def main():\n    print("Hello from your Python automation script 🐍")\n\n\nif __name__ == "__main__":\n    main()\n',
      "requirements.txt": "# add your dependencies here\n",
      "README.md": "# Python Automation Script\n\nRun with: `python main.py`\n",
    },
  },

  vanilla: {
    files: {
      "index.html":
        '<!doctype html>\n<html>\n  <head>\n    <meta charset="utf-8" />\n    <title>My Portfolio</title>\n    <link rel="stylesheet" href="styles.css" />\n  </head>\n  <body>\n    <header><h1>Hi, I\'m a Developer 🎨</h1></header>\n    <main><p>Welcome to my portfolio.</p></main>\n    <script src="script.js"></script>\n  </body>\n</html>\n',
      "styles.css":
        "body { font-family: system-ui; margin: 0; color: #222; }\nheader { padding: 60px 24px; background: linear-gradient(135deg,#6a8dff,#9b6aff); color: #fff; }\nmain { padding: 24px; }\n",
      "script.js": "console.log('Portfolio loaded');\n",
    },
  },
};

/**
 * Create a project folder, scaffold its blueprint files (writeFileSync), and
 * return its init command (if any) for the caller to run in the runtime.
 */
export function createProject(
  projectsRoot: string,
  name: string,
  blueprint: Blueprint,
): { dir: string; init?: string } {
  const dir = resolveProject(projectsRoot, name);
  if (fs.existsSync(dir)) throw new Error(`A project named "${name}" already exists.`);
  fs.mkdirSync(dir, { recursive: true });

  const def = BLUEPRINTS[blueprint] ?? BLUEPRINTS.blank;
  for (const [rel, content] of Object.entries(def.files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return { dir, init: def.init };
}

export function projectInfo(projectsRoot: string, name: string): ProjectInfo {
  const abs = resolveProject(projectsRoot, name);
  const stat = fs.statSync(abs);
  const entryCount = fs.readdirSync(abs).filter((n) => !HIDDEN.has(n)).length;
  return { name, lastModifiedMs: stat.mtimeMs, entryCount };
}
