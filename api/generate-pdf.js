import puppeteerCore from 'puppeteer-core';
import chromium from "@sparticuz/chromium-min";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import QRCode from "qrcode";

function wrapText(text, maxWidth, font, fontSize) {
  const words = text.split(" ");
  const lines = [];
  let currentLine = "";

  for (let word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (font.widthOfTextAtSize(testLine, fontSize) <= maxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let browser = null;

  try {
    const {
      html = "<h1>Hello World</h1>",
      watermarkUrl,
      code = "https://example.com",
      codeName = "Sample Code",
    } = req.body || {};

    // Launch Chromium serverless
   const executablePath = await chromium.executablePath(
  "https://github.com/Sparticuz/chromium/releases/download/v138.0.2/chromium-v138.0.2-pack.x64.tar"
);

const browser = await puppeteerCore.launch({
  args: chromium.args,
  defaultViewport: chromium.defaultViewport,
  executablePath,
  headless: chromium.headless,
});

    const page = await browser.newPage();

    const pageCss = `
      <style>
        @page { size: A4; margin: 25mm 0 20mm 0; }
        @page :first { margin-top: 0mm; margin-bottom: 20mm; }
        body { margin: 0; font-family: Arial, sans-serif; }
        .avoid-break, img, table { break-inside: avoid; page-break-inside: avoid; }
        .keep-together { break-inside: avoid; page-break-inside: avoid; }
      </style>
    `;

    let htmlWithCss;
    if (/<head[\s>]/i.test(html)) {
      htmlWithCss = html.replace(/<head[^>]*>/i, (m) => m + pageCss);
    } else if (/<html[\s>]/i.test(html)) {
      htmlWithCss = html.replace(
        /<html[^>]*>/i,
        (m) => m + `<head>${pageCss}</head>`
      );
    } else {
      htmlWithCss = `<!doctype html><html><head>${pageCss}</head><body>${html}</body></html>`;
    }

    await page.setContent(htmlWithCss, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });

    await browser.close();

    // Load PDF vào pdf-lib
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const resp = await fetch("https://iwjtpmzjlzoggj53.public.blob.vercel-storage.com/watermark.jpg");
    const bytes = await resp.arrayBuffer();
    const watermarkImg = await pdfDoc.embedPng(bytes);



    // QR Code
    const qrCodeBuffer = await QRCode.toBuffer(code, {
      width: 200,
      margin: 1,
      color: { dark: "#000000", light: "#FFFFFF" },
    });
    const qrImg = await pdfDoc.embedPng(qrCodeBuffer);

    const qrSize = 40;
    const fontSize = 6;
    const margin = 5;
    const watermarkOpacity = 0.1;
    const qrOpacity = 0.5;
    const textOpacity = 0.5;

    pdfDoc.getPages().forEach((p) => {
      const { width, height } = p.getSize();

      // Watermark giữa trang
      if (watermarkImg) {
        const scaleFactor = (width * 0.5) / watermarkImg.width;
        const scaled = watermarkImg.scale(scaleFactor);

        p.drawImage(watermarkImg, {
          x: (width - scaled.width) / 2,
          y: (height - scaled.height) / 2,
          width: scaled.width,
          height: scaled.height,
          opacity: watermarkOpacity,
        });
      }

      // QR code
      const qrX = width - qrSize - margin;
      const qrY = height - qrSize - margin;
      p.drawImage(qrImg, {
        x: qrX,
        y: qrY,
        width: qrSize,
        height: qrSize,
        opacity: qrOpacity,
      });

      // Text dưới QR
      const lines = wrapText(codeName, qrSize, font, fontSize);
      const textY = qrY - 12;
      lines.forEach((line, idx) => {
        const textWidth = font.widthOfTextAtSize(line, fontSize);
        const textX = qrX + (qrSize - textWidth) / 2;
        p.drawText(line, {
          x: textX,
          y: textY + 10,
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
          opacity: textOpacity,
        });
        textY -= fontSize + 2;
      });
    });

    const pdfBytes = await pdfDoc.save();
    const base64Pdf = Buffer.from(pdfBytes).toString("base64");

    res.status(200).json({ success: true, pdfBase64: base64Pdf });
  } catch (err) {
    console.error("❌ Error:", err);
    if (browser) await browser.close();
    res.status(500).json({ error: err.message });
  }
}