// BF-2640-084: where a signature goes. Andrew locked the placement:
//   - On the sales contract, the signature goes in the signature box.
//   - On the drawing, the signature goes near the edge of the page.
// BOS does not pick any other spot. A contract image does not tell BOS where
// its signature box is, so Andrew marks that box on the Sign page, and the
// signature is fitted inside the box Andrew marked. A drawing needs no marking: the
// signature sits inside the bottom-right corner, a small margin from the edge.
//
// signaturePlacement is plain JavaScript with no requires, so the Sign page
// ships this same function to the browser (Function.prototype.toString) and
// the server and the page can never disagree about the spot.

const SIGNATURE_TARGETS = {
  contract: { target: 'signature_box', label: 'in the signature box' },
  drawing: { target: 'page_edge', label: 'near the edge of the page' },
};

// A guess for the Sign page's starting choice; Andrew can change it.
function signatureKindForName(name) {
  return /contract|agreement|proposal|estimate/i.test(String(name || '')) ? 'contract' : 'drawing';
}

// page: { width, height } of the page image in pixels.
// box (contract only): { x, y, w, h } the signature box Andrew marked.
// Returns { target, x, y, w, h } - the rectangle the signature is fitted into -
// or { error } when the contract box has not been marked.
function signaturePlacement(kind, page, box) {
  var W = Math.max(1, Number(page && page.width) || 0);
  var H = Math.max(1, Number(page && page.height) || 0);
  if (kind === 'contract') {
    if (!box || !(Number(box.w) > 0) || !(Number(box.h) > 0)) return { error: 'Mark the signature box on the contract first.' };
    var bx = Math.max(0, Math.min(W, Number(box.x)));
    var by = Math.max(0, Math.min(H, Number(box.y)));
    return {
      target: 'signature_box',
      x: Math.round(bx),
      y: Math.round(by),
      w: Math.round(Math.min(Number(box.w), W - bx)),
      h: Math.round(Math.min(Number(box.h), H - by)),
    };
  }
  if (kind === 'drawing') {
    var margin = Math.round(Math.min(W, H) * 0.02);
    var w = Math.round(W * 0.28);
    var h = Math.round(Math.min(H * 0.1, w * 0.4));
    return { target: 'page_edge', x: W - margin - w, y: H - margin - h, w: w, h: h, margin: margin };
  }
  return { error: 'Choose Sales contract or Drawing first.' };
}

module.exports = { SIGNATURE_TARGETS, signatureKindForName, signaturePlacement };
