const { mkdirSync, writeFileSync } = require("node:fs");
const { join, dirname } = require("node:path");
const { scaffoldFiles } = require("/Users/dberges/Desktop/timbal-ai/scaffold-DmcZyAOy.js");

const files = scaffoldFiles({
  template: "confirm-and-send",
  id: "com.dberges.notch-coder",
  name: "Notch Coder",
  description:
    "Speak a coding task into the notch and a Cursor agent ships it — code changes, even a PR.",
  publisherId: "pub_dberges",
  publisherName: "David Berges",
});

const out = "/Users/dberges/Desktop/timbal-ai/notch-coder";
for (const f of files) {
  const p = join(out, f.path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, f.content);
  console.log("wrote", f.path, f.content.length, "bytes");
}
