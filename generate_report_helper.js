const fs = require('fs');
const docx = require('docx');
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  PageBreak,
  BorderStyle,
  Header,
  Footer,
  PageNumber,
  NumberFormat,
  ImageRun
} = docx;

// Helper to create main chapter heading (Arial 14 Bold Uppercase)
function createMainHeading(text) {
  return new Paragraph({
    children: [
      new TextRun({
        text: text.toUpperCase(),
        font: "Arial",
        size: 28, // 14pt
        bold: true,
        color: "000000"
      })
    ],
    heading: HeadingLevel.HEADING_1,
    pageBreakBefore: true,
    spacing: { before: 240, after: 120 }
  });
}

// Helper to create subheading (Arial 12 Bold)
function createSubHeading(text) {
  return new Paragraph({
    children: [
      new TextRun({
        text: text,
        font: "Arial",
        size: 24, // 12pt
        bold: true,
        color: "000000"
      })
    ],
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 180, after: 60 }
  });
}

// Helper to create sub-subheading (Arial 12 Bold Italic)
function createSubSubHeading(text) {
  return new Paragraph({
    children: [
      new TextRun({
        text: text,
        font: "Arial",
        size: 24, // 12pt
        bold: true,
        italic: true,
        color: "000000"
      })
    ],
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 140, after: 40 }
  });
}

// Helper to create body paragraph (Arial 12)
function createParagraph(text, options = {}) {
  const runs = [];
  if (typeof text === 'string') {
    runs.push(new TextRun({
      text: text,
      font: "Arial",
      size: 24, // 12pt
      bold: !!options.bold,
      italic: !!options.italic,
      color: "000000"
    }));
  } else if (Array.isArray(text)) {
    text.forEach(item => {
      if (typeof item === 'string') {
        runs.push(new TextRun({ text: item, font: "Arial", size: 24, color: "000000" }));
      } else {
        runs.push(new TextRun({
          text: item.text,
          font: "Arial",
          size: 24,
          bold: !!item.bold,
          italic: !!item.italic,
          color: "000000"
        }));
      }
    });
  }

  return new Paragraph({
    children: runs,
    alignment: options.alignment || AlignmentType.JUSTIFY,
    spacing: { line: 276, before: 60, after: 60 },
    bullet: options.bullet ? { level: 0 } : undefined
  });
}

// Helper for table creation with Arial font
function createTable(headers, rowsData) {
  const headerCells = headers.map(header => new TableCell({
    children: [new Paragraph({
      children: [new TextRun({ text: header, font: "Arial", size: 22, bold: true, color: "FFFFFF" })],
      alignment: AlignmentType.CENTER
    })],
    shading: { fill: "2B3E50" },
    width: { size: Math.floor(100 / headers.length), type: WidthType.PERCENTAGE }
  }));

  const bodyRows = rowsData.map(rowData => {
    return new TableRow({
      children: rowData.map(cellText => new TableCell({
        children: [new Paragraph({
          children: [new TextRun({ text: cellText, font: "Arial", size: 22, color: "000000" })],
          alignment: AlignmentType.LEFT,
          spacing: { line: 240, before: 40, after: 40 }
        })],
        width: { size: Math.floor(100 / headers.length), type: WidthType.PERCENTAGE }
      }))
    });
  });

// Helper for Table of Contents item creation with dot leaders
function createTocItem(text, pageNum, level = 1) {
  let indentLeft = 0;
  let isBold = false;
  let isItalic = false;
  let fontSize = 24; // 12pt
  let beforeSpace = 80;
  let afterSpace = 40;

  if (level === 1) {
    indentLeft = 0;
    isBold = true;
    fontSize = 24;
    beforeSpace = 120;
    afterSpace = 60;
  } else if (level === 2) {
    indentLeft = 360; // 0.25 inch
    isBold = false;
    fontSize = 22;
    beforeSpace = 60;
    afterSpace = 40;
  } else if (level === 3) {
    indentLeft = 720; // 0.5 inch
    isBold = false;
    isItalic = true;
    fontSize = 22;
    beforeSpace = 40;
    afterSpace = 30;
  }

  return new Paragraph({
    indent: { left: indentLeft },
    tabStops: [
      {
        type: docx.TabStopType ? docx.TabStopType.RIGHT : 'right',
        position: 9000,
        leader: docx.LeaderType ? docx.LeaderType.DOT : 'dot'
      }
    ],
    spacing: { line: 240, before: beforeSpace, after: afterSpace },
    children: [
      new TextRun({
        text: text,
        font: "Arial",
        size: fontSize,
        bold: isBold,
        italic: isItalic,
        color: "000000"
      }),
      new docx.Tab(),
      new TextRun({
        text: String(pageNum),
        font: "Arial",
        size: fontSize,
        bold: isBold,
        color: "000000"
      })
    ]
  });
}

module.exports = {
  createMainHeading,
  createSubHeading,
  createSubSubHeading,
  createParagraph,
  createTable,
  createTocItem
};

console.log("Helper script initialized.");
