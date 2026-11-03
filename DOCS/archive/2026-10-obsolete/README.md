# Operating-plan document builder

`build_v36.js` generates the MGPL Joint AI Agent Operating Plan DOCX. It is a documentation utility, not part of the MGPL application build or runtime.

## Prerequisite

The script requires the [`docx`](https://www.npmjs.com/package/docx) npm package. Install repository dependencies first with `npm ci`; do not add a separate application dependency for this builder.

## Usage

From the repository root, run:

```powershell
node DOCS/build/build_v36.js
```

The output path is defined inside `build_v36.js` and follows the script's existing behavior. Review the generated document before treating it as an approved operating-plan artifact.
