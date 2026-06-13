import { MODULE_ID } from '../config.js';

const ApplicationV2 = foundry.applications.api.ApplicationV2;
const HandlebarsApplicationMixin = foundry.applications.api.HandlebarsApplicationMixin;

/**
 * Book viewer window for PDF-type book notes.
 * One singleton per drawing document (id: "book-viewer-{drawingId}").
 *
 * Spread layout mimics a real book:
 *   Spread 0 → cover (page 1 alone, centered)
 *   Spread 1 → pages 2–3  (left–right)
 *   Spread 2 → pages 4–5
 *   …
 *   Last spread → back cover alone (last page centered) when total is even,
 *                 or last page on the left when total is odd.
 */
export class BookViewer extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(document, options = {}) {
    options.id = `book-viewer-${document.id}`;
    super(options);
    this.document = document;

    /** @type {import('pdfjs-dist').PDFDocumentProxy|null} */
    this._pdfDoc = null;
    this._totalPages = 0;
    /** Current spread index (0 = cover) */
    this._currentSpread = 0;
    this._maxSpread = 0;
    /** True while a flip animation is running — blocks navigation input */
    this._flipping = false;
    this._resizeTimeout = null;
  }

  static DEFAULT_OPTIONS = {
    tag: 'div',
    classes: ['ib-book-viewer-app'],
    window: {
      title: 'Book',
      resizable: true,
      minimizable: true,
      icon: 'fas fa-book-open',
    },
    position: {
      width: 900,
      height: 550,
    },
  };

  static PARTS = {
    content: {
      template: 'modules/investigation-board/templates/book-viewer.html',
    },
  };

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  async _prepareContext(options) {
    const noteData = this.document.flags[MODULE_ID] || {};
    return {
      pdfPath: noteData.pdfPath || '',
      title: noteData.text || 'Book',
    };
  }

  /** @override */
  get title() {
    const noteData = this.document.flags[MODULE_ID] || {};
    return noteData.text || 'Book';
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  async _onRender(context, options) {
    super._onRender?.(context, options);

    // Update window title
    const titleEl = this.element.querySelector('.window-title')
      || this.element.closest('.app, .window, .window-app, foundry-app')?.querySelector('.window-title');
    if (titleEl && context.title) titleEl.textContent = context.title;

    if (!context.pdfPath) return;

    // Focus the viewer so keyboard events work immediately
    const viewer = this.element.querySelector('.ib-book-viewer');
    if (viewer) viewer.focus();

    // Load PDF
    await this._loadPdf(context.pdfPath);
    if (!this._pdfDoc) return;

    // Render initial spread (cover)
    this._currentSpread = 0;
    await this._renderCurrentSpread();

    // --- Wire up navigation ---
    const prevBtn = this.element.querySelector('.ib-book-prev');
    const nextBtn = this.element.querySelector('.ib-book-next');

    prevBtn?.addEventListener('click', () => this._goToSpread(this._currentSpread - 1));
    nextBtn?.addEventListener('click', () => this._goToSpread(this._currentSpread + 1));

    // Clickable page halves
    const leftPage = this.element.querySelector('.ib-book-page-left');
    const rightPage = this.element.querySelector('.ib-book-page-right');
    leftPage?.addEventListener('click', () => this._goToSpread(this._currentSpread - 1));
    rightPage?.addEventListener('click', () => this._goToSpread(this._currentSpread + 1));

    // Keyboard navigation
    viewer?.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); this._goToSpread(this._currentSpread - 1); }
      if (ev.key === 'ArrowRight') { ev.preventDefault(); this._goToSpread(this._currentSpread + 1); }
      if (ev.key === 'Home') { ev.preventDefault(); this._goToSpread(0); }
      if (ev.key === 'End') { ev.preventDefault(); this._goToSpread(this._maxSpread); }
    });

    // Jump-to-page input
    const jumpInput = this.element.querySelector('.ib-page-jump');
    if (jumpInput) {
      jumpInput.addEventListener('change', () => {
        const pageNum = Math.clamp(parseInt(jumpInput.value) || 1, 1, this._totalPages);
        // Convert page number to spread index
        const spreadIndex = pageNum === 1 ? 0 : Math.ceil((pageNum - 1) / 2);
        this._goToSpread(spreadIndex);
      });
      // Prevent keyboard navigation while typing in the input
      jumpInput.addEventListener('keydown', (ev) => ev.stopPropagation());
    }
  }

  // ---------------------------------------------------------------------------
  // PDF Loading
  // ---------------------------------------------------------------------------

  async _loadPdf(pdfPath) {
    try {
      // Dynamic import of PDF.js from the bundled location
      const pdfjsLib = await import('../lib/pdfjs/pdf.min.mjs');
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'modules/investigation-board/scripts/lib/pdfjs/pdf.worker.min.mjs';

      // Resolve the full URL for the PDF path (Foundry stores paths like "assets/foo.pdf")
      const url = foundry.utils.getRoute(pdfPath);
      this._pdfDoc = await pdfjsLib.getDocument(url).promise;
      this._totalPages = this._pdfDoc.numPages;

      // Calculate max spread index
      // Spread 0 = page 1 (cover)
      // Spreads 1..N = pairs of pages
      // If totalPages is even: last spread has one page (back cover centered)
      // If totalPages is odd: last spread has one page on left, empty right
      this._maxSpread = Math.ceil((this._totalPages - 1) / 2);
      // Edge case: single page PDF
      if (this._totalPages <= 1) this._maxSpread = 0;

      // Update total pages display
      const totalEl = this.element.querySelector('.ib-total-pages');
      if (totalEl) totalEl.textContent = this._totalPages;

      const jumpInput = this.element.querySelector('.ib-page-jump');
      if (jumpInput) jumpInput.max = this._totalPages;

    } catch (err) {
      console.error('Investigation Board: Failed to load PDF', err);
      ui.notifications.error('Failed to load PDF file. Check the file path.');
    }
  }

  // ---------------------------------------------------------------------------
  // Spread rendering
  // ---------------------------------------------------------------------------

  /**
   * Get the page numbers for a given spread index.
   * @param {number} spreadIndex
   * @returns {{ left: number|null, right: number|null }}
   */
  _getSpreadPages(spreadIndex) {
    if (spreadIndex === 0) {
      // Cover: page 1 only (show centered — rendered on right side, left hidden)
      return { left: null, right: 1 };
    }

    const leftPageNum = spreadIndex * 2;
    const rightPageNum = spreadIndex * 2 + 1;

    return {
      left: leftPageNum <= this._totalPages ? leftPageNum : null,
      right: rightPageNum <= this._totalPages ? rightPageNum : null,
    };
  }

  /**
   * Render a single PDF page onto a <canvas> element.
   * @param {number} pageNum — 1-indexed page number
   * @param {HTMLCanvasElement} canvas
   */
  async _renderPage(pageNum, canvas) {
    if (!this._pdfDoc || !canvas) return;

    const page = await this._pdfDoc.getPage(pageNum);
    const container = canvas.parentElement;
    const containerWidth = container.clientWidth || 380;
    const containerHeight = container.clientHeight || 500;

    // Calculate scale to fit the page within the container
    const viewport = page.getViewport({ scale: 1 });
    const scaleX = containerWidth / viewport.width;
    const scaleY = containerHeight / viewport.height;
    const scale = Math.min(scaleX, scaleY) * (window.devicePixelRatio || 1);

    const scaledViewport = page.getViewport({ scale });
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;

    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
  }

  /**
   * Render the current spread (no animation).
   */
  async _renderCurrentSpread() {
    const { left, right } = this._getSpreadPages(this._currentSpread);
    const leftCanvas = this.element.querySelector('.ib-book-page-left .ib-page-canvas');
    const rightCanvas = this.element.querySelector('.ib-book-page-right .ib-page-canvas');
    const leftPage = this.element.querySelector('.ib-book-page-left');
    const rightPage = this.element.querySelector('.ib-book-page-right');

    // Show/hide pages based on whether they have content
    if (leftPage) leftPage.classList.toggle('ib-page-empty', !left);
    if (rightPage) rightPage.classList.toggle('ib-page-empty', !right);

    // Determine if this is a single-page spread (cover or back cover)
    const isSingle = !left || !right;
    const spread = this.element.querySelector('.ib-book-spread');
    if (spread) spread.classList.toggle('ib-single-page', isSingle);

    // Render pages
    if (left && leftCanvas) await this._renderPage(left, leftCanvas);
    if (right && rightCanvas) await this._renderPage(right, rightCanvas);

    // Clear empty canvases
    if (!left && leftCanvas) {
      const ctx = leftCanvas.getContext('2d');
      ctx.clearRect(0, 0, leftCanvas.width, leftCanvas.height);
    }
    if (!right && rightCanvas) {
      const ctx = rightCanvas.getContext('2d');
      ctx.clearRect(0, 0, rightCanvas.width, rightCanvas.height);
    }

    this._updateNavState();
  }

  // ---------------------------------------------------------------------------
  // Navigation with flip animation
  // ---------------------------------------------------------------------------

  /**
   * Navigate to a target spread with optional page-flip animation.
   * @param {number} targetSpread
   */
  async _goToSpread(targetSpread) {
    if (this._flipping) return;
    if (targetSpread < 0 || targetSpread > this._maxSpread) return;
    if (targetSpread === this._currentSpread) return;

    const direction = targetSpread > this._currentSpread ? 'next' : 'prev';
    this._flipping = true;

    // The page that flips: right page flips when going forward, left when going back
    const flipPage = direction === 'next'
      ? this.element.querySelector('.ib-book-page-right')
      : this.element.querySelector('.ib-book-page-left');

    if (flipPage) {
      const animClass = direction === 'next' ? 'ib-flip-forward' : 'ib-flip-backward';
      flipPage.classList.add(animClass);

      // Wait for the animation to complete (600ms matches CSS)
      await new Promise(resolve => {
        const onEnd = () => { flipPage.removeEventListener('animationend', onEnd); resolve(); };
        flipPage.addEventListener('animationend', onEnd);
        // Safety timeout in case animationend doesn't fire
        setTimeout(resolve, 700);
      });

      flipPage.classList.remove(animClass);
    }

    this._currentSpread = targetSpread;
    await this._renderCurrentSpread();
    this._flipping = false;
  }

  /**
   * Update navigation button disabled states and page indicator.
   */
  _updateNavState() {
    const prevBtn = this.element.querySelector('.ib-book-prev');
    const nextBtn = this.element.querySelector('.ib-book-next');
    if (prevBtn) prevBtn.disabled = this._currentSpread <= 0;
    if (nextBtn) nextBtn.disabled = this._currentSpread >= this._maxSpread;

    // Update page indicator — show the first visible page number
    const { left, right } = this._getSpreadPages(this._currentSpread);
    const displayPage = left || right || 1;
    const jumpInput = this.element.querySelector('.ib-page-jump');
    if (jumpInput) jumpInput.value = displayPage;

    // Update cursor on pages
    const leftPage = this.element.querySelector('.ib-book-page-left');
    const rightPage = this.element.querySelector('.ib-book-page-right');
    if (leftPage) leftPage.style.cursor = this._currentSpread > 0 ? 'pointer' : 'default';
    if (rightPage) rightPage.style.cursor = this._currentSpread < this._maxSpread ? 'pointer' : 'default';
  }

  // ---------------------------------------------------------------------------
  // Window Management & Resizing
  // ---------------------------------------------------------------------------

  /** @override */
  setPosition(position = {}) {
    const prior = { ...this.position };
    const result = super.setPosition(position);

    const widthChanged = position.width !== undefined && position.width !== prior.width;
    const heightChanged = position.height !== undefined && position.height !== prior.height;

    if (this.rendered && (widthChanged || heightChanged)) {
      this._handleResize();
    }
    return result;
  }

  /**
   * Debounce rendering of the current spread on window resize to avoid lagging.
   */
  _handleResize() {
    if (this._resizeTimeout) clearTimeout(this._resizeTimeout);
    this._resizeTimeout = setTimeout(() => {
      if (!this.rendered || this._flipping) return;
      this._renderCurrentSpread();
    }, 150);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async _onClose(options) {
    if (this._resizeTimeout) {
      clearTimeout(this._resizeTimeout);
      this._resizeTimeout = null;
    }
    if (this._pdfDoc) {
      this._pdfDoc.destroy();
      this._pdfDoc = null;
    }
    return super._onClose?.(options);
  }
}
