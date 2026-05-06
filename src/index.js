const puppeteer = require("puppeteer");
const axios = require("axios");
const xml2js = require("xml2js");
const { PDFDocument } = require("pdf-lib");
const fs = require("fs");
const path = require("path");

const URL_GITBOOK = "https://docs.walken.io";

const IMAGE_LOAD_TIMEOUT_MS = 15000;

// Trigger lazy-loaded assets by scrolling through the document once.
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 600;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 100);
    });
  });
}

// Wait until <img> elements are fully decoded or timeout is reached.
async function waitForImages(page, timeoutMs = IMAGE_LOAD_TIMEOUT_MS) {
  try {
    await page.waitForFunction(
      () => {
        const images = Array.from(document.images);
        if (images.length === 0) {
          return true;
        }

        return images.every((img) => img.complete && img.naturalWidth > 0);
      },
      { timeout: timeoutMs }
    );
  } catch (error) {
    // Continue even if some images time out to avoid failing the whole run.
    console.warn("Some images may not be fully loaded before PDF render.");
  }
}

// Function to fetch the sitemap XML and parse it
async function fetchSitemap(url) {
  try {
    const response = await axios.get(url);
    const sitemapXML = response.data;

    // Parse the XML sitemap into JSON and strip namespace prefixes if present.
    const parsedSitemap = await xml2js.parseStringPromise(sitemapXML, {
      tagNameProcessors: [xml2js.processors.stripPrefix],
    });

    // Standard sitemap with direct URLs.
    if (parsedSitemap.urlset?.url) {
      return parsedSitemap.urlset.url
        .map((entry) => entry?.loc?.[0])
        .filter(Boolean);
    }

    // Sitemap index that points to one or more child sitemaps.
    if (parsedSitemap.sitemapindex?.sitemap) {
      const sitemapUrls = parsedSitemap.sitemapindex.sitemap
        .map((entry) => entry?.loc?.[0])
        .filter(Boolean);

      const nestedUrls = await Promise.all(sitemapUrls.map(fetchSitemap));
      return nestedUrls.flat().filter(Boolean);
    }

    throw new Error("Unsupported sitemap format");
  } catch (error) {
    console.error("Error fetching or parsing sitemap:", error);
    return [];
  }
}

// Function to convert a page to PDF with selectable text and high-quality images
async function takeFullPagePdf(page, url, outputPath) {
  try {
    // Set the viewport to a reasonable width (e.g., 1280px) for full-page capture
    await page.setViewport({ width: 1280, height: 800 });

    // Set device scale factor for high DPI (2 is Retina)
    await page.emulate({
      viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
      userAgent: "",
    });

    // Go to the page and wait for it to load completely
    await page.goto(url, { waitUntil: "networkidle2" });

    // Ensure lazy-loaded resources have a chance to render.
    await autoScroll(page);
    await waitForImages(page);

    // Remove elements by setting display to 'none'
    await page.evaluate(() => {
      // Remove the AppBar element
      const appBar = document.querySelector("div.appBarClassName"); // Replace with the correct selector for the AppBar
      if (appBar) {
        appBar.style.display = "none"; // Hide the AppBar
      }

      // Remove the element with class "scroll-nojump"
      const scrollNoJump = document.querySelector(".scroll-nojump");
      if (scrollNoJump) {
        scrollNoJump.style.display = "none"; // Hide the scroll-nojump element
      }

      // Remove the menu element
      const menu = document.querySelector(
        "aside.relative.group.flex.flex-col.basis-full.bg-light"
      );
      if (menu) {
        menu.style.display = "none"; // Hide the menu
      }

      // Remove the search button
      const searchButton = document.querySelector(
        "div.flex.md\\:w-56.grow-0.shrink-0.justify-self-end"
      );
      if (searchButton) {
        searchButton.style.display = "none"; // Hide the search button div
      }

      // Remove the next button div
      const nextButton = document.querySelector(
        "div.flex.flex-col.md\\:flex-row.mt-6.gap-2.max-w-3xl.mx-auto.page-api-block\\:ml-0"
      );
      if (nextButton) {
        nextButton.style.display = "none"; // Hide the next button div
      }

      // Remove the "Last updated" info
      const lastUpdatedInfo = document.querySelector(
        "div.flex.flex-row.items-center.mt-6.max-w-3xl.mx-auto.page-api-block\\:ml-0"
      );
      if (lastUpdatedInfo) {
        lastUpdatedInfo.style.display = "none"; // Hide the "Last updated" div
      }
    });

    // Convert the page to PDF with high-quality images
    await page.pdf({
      path: outputPath,
      format: "A4", // Use A4 paper size for PDF
      printBackground: true, // Ensure background images and colors are included
      scale: 1, // Keep the original scale
      preferCSSPageSize: true, // Ensure that the page uses CSS page size
    });

    console.log(`Saved PDF for: ${url} at ${outputPath}`);
  } catch (error) {
    console.error(`Failed to take PDF for: ${url}`, error);
  }
}

// Function to group URLs based on their categories (like 'settings', 'android')
function categorizeUrl(url) {
  const parts = url.split("/");
  if (parts.length < 5) {
    return "home"; // Root page or unexpected path shape
  }
  const category = parts[4]; // Assuming categories are the 5th part of the URL
  return category; // Return the category name (e.g., 'settings', 'android')
}

// Merge multiple PDFs into a single output file.
async function mergePdfs(inputPaths, outputPath) {
  const mergedPdf = await PDFDocument.create();

  for (const pdfPath of inputPaths) {
    const bytes = fs.readFileSync(pdfPath);
    const sourcePdf = await PDFDocument.load(bytes);
    const pages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());

    for (const page of pages) {
      mergedPdf.addPage(page);
    }
  }

  const mergedBytes = await mergedPdf.save();
  fs.writeFileSync(outputPath, mergedBytes);
}
// function categorizeUrl(url) {
//   const parts = url.split("/");
//   const category = parts[4]; // Assuming categories are the 5th part of the URL

//   return category; // Return the category name (e.g., 'settings', 'android')
// }

// Main function to run the script
async function run() {
  const sitemapUrl = `${URL_GITBOOK.replace(/\/+$/, "")}/sitemap.xml`;
  const saveDir = "./pdfs"; // Directory where PDFs will be saved
  const tempDir = path.join(saveDir, ".tmp_pages");
  const mergedPdfPath = path.join(saveDir, "rxpacs_completo.pdf");

  // Create the output directory if it doesn't exist
  if (!fs.existsSync(saveDir)) {
    fs.mkdirSync(saveDir);
  }

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Fetch the sitemap URLs
  const urls = await fetchSitemap(sitemapUrl);
  if (!urls) return;

  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  const generatedPdfPaths = [];

  // Initialize the page counter
  let pageCounter = 1;

  // Loop through each URL in the sitemap
  for (const url of urls) {
    // Generate a sequential filename for the PDF (page_1.pdf, page_2.pdf, ...)
    const pdfFileName = `page_${pageCounter}.pdf`; // Use pageCounter for unique file names
    const pdfPath = path.join(tempDir, pdfFileName);

    // Capture the full page as a PDF
    await takeFullPagePdf(page, url, pdfPath);
    generatedPdfPaths.push(pdfPath);

    // Increment the page counter
    pageCounter++;
  }

  await browser.close();

  if (generatedPdfPaths.length === 0) {
    console.log("No pages found in sitemap. No PDF generated.");
    return;
  }

  await mergePdfs(generatedPdfPaths, mergedPdfPath);

  // Cleanup temporary PDFs after merging.
  for (const pdfPath of generatedPdfPaths) {
    if (fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
    }
  }

  if (fs.existsSync(tempDir)) {
    fs.rmdirSync(tempDir);
  }

  console.log(`Merged PDF created at: ${mergedPdfPath}`);
}

run().catch(console.error);
