import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import QRCode from 'qrcode';

// Configure chromium for serverless environment
chromium.setGraphicsMode = false;

function wrapText(text, maxWidth, font, fontSize) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';

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
  let browser = null;
  
  try {
    const {
      html = '<h1>Hello World</h1>',
      watermarkUrl,
      code = 'https://example.com',
      codeName = 'Sample Code'
    } = req.body || {};

    // Kiểm tra method
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // Khởi tạo browser với cấu hình cho Vercel
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    
    // Set timeout để tránh lỗi
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);

    const pageCss = `
      <style>
        @page { size: A4; margin: 25mm 0 20mm 0; }
        @page :first { margin-top: 0mm; margin-bottom: 20mm; }
        body { margin: 0; font-family: Arial, sans-serif; }
        .avoid-break, img, table { break-inside: avoid; page-break-inside: avoid; }
        .keep-together { break-inside: avoid; page-break-inside: avoid; }
        * { box-sizing: border-box; }
      </style>
    `;

    let htmlWithCss;
    if (/<head[\s>]/i.test(html)) {
      htmlWithCss = html.replace(/<head[^>]*>/i, (m) => m + pageCss);
    } else if (/<html[\s>]/i.test(html)) {
      htmlWithCss = html.replace(/<html[^>]*>/i, (m) => m + `<head>${pageCss}</head>`);
    } else {
      htmlWithCss = `<!doctype html><html><head>${pageCss}</head><body>${html}</body></html>`;
    }

    await page.setContent(htmlWithCss, { 
      waitUntil: 'networkidle0',
      timeout: 30000 
    });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });

    await browser.close();

    // Xử lý PDF với pdf-lib
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    let watermarkImg = null;
    if (watermarkUrl) {
      try {
        const watermarkResponse = await fetch(watermarkUrl);
        const watermarkBytes = await watermarkResponse.arrayBuffer();
        watermarkImg = await pdfDoc.embedPng(watermarkBytes);
      } catch (error) {
        console.warn('Failed to load watermark image:', error.message);
      }
    }

    const qrCodeBuffer = await QRCode.toBuffer(code, {
      width: 200,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
    const qrImg = await pdfDoc.embedPng(qrCodeBuffer);

    const qrSize = 40;
    const fontSize = 6;
    const margin = 10;
    const watermarkOpacity = 0.1;
    const qrOpacity = 0.7;
    const textOpacity = 0.7;

    const pages = pdfDoc.getPages();
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const { width, height } = page.getSize();

      // Vẽ watermark (nếu có)
      if (watermarkImg) {
        const scale = Math.min(
          (width * 0.6) / watermarkImg.width,
          (height * 0.6) / watermarkImg.height
        );
        const scaledWidth = watermarkImg.width * scale;
        const scaledHeight = watermarkImg.height * scale;
        
        page.drawImage(watermarkImg, {
          x: (width - scaledWidth) / 2,
          y: (height - scaledHeight) / 2,
          width: scaledWidth,
          height: scaledHeight,
          opacity: watermarkOpacity,
        });
      }

      // Vẽ QR code ở góc dưới bên phải
      const qrX = width - qrSize - margin;
      const qrY = margin;

      page.drawImage(qrImg, {
        x: qrX,
        y: qrY,
        width: qrSize,
        height: qrSize,
        opacity: qrOpacity,
      });

      // Vẽ text bên dưới QR code
      const textY = qrY + qrSize + 2;
      const maxTextWidth = qrSize;

      const lines = wrapText(codeName, maxTextWidth, font, fontSize);
      
      for (let j = 0; j < lines.length; j++) {
        const line = lines[j];
        const textWidth = font.widthOfTextAtSize(line, fontSize);
        const textX = qrX + (qrSize - textWidth) / 2;
        
        page.drawText(line, {
          x: textX,
          y: textY - (j * (fontSize + 1)),
          size: fontSize,
          font: font,
          color: rgb(0, 0, 0),
          opacity: textOpacity,
        });
      }
    }

    const pdfBytes = await pdfDoc.save();
    const base64Pdf = Buffer.from(pdfBytes).toString('base64');

    res.status(200).json({ 
      success: true,
      pdfBase64: base64Pdf,
      pages: pdfDoc.getPageCount()
    });

  } catch (err) {
    console.error('❌ Error generating PDF:', err);
    
    // Đảm bảo đóng browser nếu có lỗi
    if (browser) {
      await browser.close();
    }
    
    res.status(500).json({ 
      error: 'Failed to generate PDF', 
      details: err.message,
      suggestion: 'Check the HTML content and try again' 
    });
  }
}