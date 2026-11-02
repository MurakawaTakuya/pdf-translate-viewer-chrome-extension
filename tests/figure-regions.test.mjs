import test from "node:test";
import assert from "node:assert/strict";
import { OPS } from "../lib/pdf.min.mjs";
import { drawingGeometry, excludeFigureText } from "../figure-regions.js";
const b = (text, x0, top, x1, bottom, kind = "paragraph") => ({
  text,
  x0,
  top,
  x1,
  bottom,
  kind,
  translate: true,
  lines: [{}],
});
const rule = (x0, top, x1) => ({ x0, x1, top, bottom: top });

test("form transforms and save/restore produce page-coordinate regions without leaking matrix state", () => {
  const list = [
    [OPS.save, []],
    [OPS.transform, [1, 0, 0, 1, 100, 200]],
    [
      OPS.paintFormXObjectBegin,
      [
        [2, 0, 0, 2, 0, 0],
        [0, 0, 100, 60],
      ],
    ],
    [OPS.paintFormXObjectEnd, []],
    [OPS.restore, []],
    [OPS.save, []],
    [OPS.transform, [80, 0, 0, 40, 20, 30]],
    [OPS.paintImageXObject, ["image", 80, 40]],
    [OPS.restore, []],
    [
      OPS.constructPath,
      [
        [OPS.moveTo, OPS.lineTo],
        [0, 10, 200, 10],
        [0, 10, 200, 10],
      ],
    ],
    [OPS.stroke, []],
  ];
  const g = drawingGeometry(
    { fnArray: list.map((x) => x[0]), argsArray: list.map((x) => x[1]) },
    { scale: 1, transform: [1, 0, 0, -1, 0, 800] }
  );
  assert.deepEqual(g.graphics, [
    { x0: 100, top: 480, x1: 300, bottom: 600 },
    { x0: 20, top: 730, x1: 100, bottom: 770 },
  ]);
  assert.deepEqual(g.rules, [{ x0: 0, top: 790, x1: 200, bottom: 790 }]);
});

test("figure labels and subfigure names stay original while caption and outside prose translate", () => {
  const blocks = [
    b("A long descriptive label in the plot", 100, 100, 260, 112),
    b("(a) Joint embedding architecture", 100, 205, 260, 215),
    b("Figure 2. Architecture comparison.", 50, 225, 550, 245, "caption"),
    b("The next body paragraph.", 50, 270, 260, 290),
    b("Body in another column.", 320, 100, 540, 125),
  ];
  excludeFigureText(
    blocks,
    { graphics: [{ x0: 100, x1: 260, top: 100, bottom: 200 }], rules: [] },
    10,
    800
  );
  assert.deepEqual(
    blocks.map((b) => b.translate),
    [false, false, true, true, true]
  );
  assert.equal(blocks[0].translationSkip, "figure");
});

test("table headings and cells remain original, including narrow partial caption lead-ins", () => {
  const blocks = [
    b("Method and architecture", 80, 70, 270, 80, "heading"),
    b("Methods without extra augmentations", 80, 100, 270, 112),
    b("Second group of table rows", 80, 160, 270, 175),
    b("Table 2.", 60, 200, 92, 210, "caption"),
    b("Body below the caption.", 60, 245, 280, 270),
  ];
  excludeFigureText(
    blocks,
    { graphics: [], rules: [rule(80, 85, 270), rule(80, 140, 270)] },
    10,
    800
  );
  assert.deepEqual(
    blocks.map((b) => b.translate),
    [false, false, false, true, true]
  );
  assert.equal(blocks[1].translationSkip, "table");
});

test("stacked tables use the preceding table even if the next header rule is closer", () => {
  const blocks = [
    b("First table header", 220, 75, 380, 85, "heading"),
    b("First table rows", 220, 125, 380, 145),
    b("Table 8. First caption.", 50, 185, 550, 215, "caption"),
    b("Second table header", 220, 233, 380, 243, "heading"),
    b("Second table rows", 220, 280, 380, 300),
    b("Table 9. Second caption.", 50, 322, 550, 352, "caption"),
  ];
  const g = {
    graphics: [],
    rules: [
      rule(220, 86, 290),
      rule(214, 101, 382),
      rule(220, 245, 290),
      rule(214, 260, 382),
    ],
  };
  const regions = excludeFigureText(blocks, g, 10, 800);
  assert.ok(regions[0].bottom < 215);
  assert.ok(regions[1].top >= 215);
  assert.deepEqual(
    blocks.map((b) => b.translate),
    [false, false, true, false, false, true]
  );
});

test("a caption immediately above a table works and a page-sized form does not swallow body text", () => {
  const blocks = [
    b("Table 1. Caption above.", 50, 50, 280, 70, "caption"),
    b("Column heading", 50, 90, 280, 100, "heading"),
    b("Table row", 50, 120, 280, 130),
    b("Next paragraph.", 50, 170, 280, 190),
  ];
  excludeFigureText(
    blocks,
    { graphics: [], rules: [rule(50, 82, 280), rule(50, 140, 280)] },
    10,
    800
  );
  assert.deepEqual(
    blocks.map((b) => b.translate),
    [true, false, false, true]
  );
  const page = [
    b("Figure 1. In a page-sized form.", 50, 150, 280, 175, "caption"),
    b("Body that must translate.", 50, 200, 280, 230),
  ];
  excludeFigureText(
    page,
    { graphics: [{ x0: 0, x1: 600, top: 0, bottom: 800 }], rules: [] },
    10,
    800
  );
  assert.ok(page.every((b) => b.translate));
});

test("captions and unlabeled ordinary text are not excluded without drawing evidence", () => {
  const blocks = [
    b("References", 50, 100, 150, 112, "heading"),
    b("Ordinary body text.", 50, 125, 250, 150),
  ];
  assert.deepEqual(
    excludeFigureText(blocks, { graphics: [], rules: [] }, 10, 800),
    []
  );
  assert.ok(blocks.every((b) => b.translate));
});

test("stacked captions above tables do not reuse an earlier table or swallow intervening prose", () => {
  const blocks = [
    b("Table 1. First caption.", 50, 40, 250, 50, "caption"),
    b("First table cells", 50, 65, 250, 95),
    b("Our method outperforms the baseline.", 50, 110, 250, 120),
    b("Table 2. Second caption.", 50, 125, 250, 135, "caption"),
    b("Second table cells", 50, 160, 250, 185),
  ];
  excludeFigureText(
    blocks,
    {
      graphics: [],
      rules: [
        rule(50, 60, 250),
        rule(50, 100, 250),
        rule(50, 155, 250),
        rule(50, 190, 250),
      ],
    },
    10,
    800
  );
  assert.deepEqual(
    blocks.map((b) => b.translate),
    [true, false, true, true, false]
  );
});
