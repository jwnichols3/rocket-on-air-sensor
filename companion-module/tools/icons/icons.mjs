// The button art (#92), as shapes. `npm run icons` rasterises this to src/icons.js.
//
// PUBLIC SIGNAGE is the design language, chosen by a blind judging of six: the ISO/AIGA
// shapes an adult already knows without being taught. It won 7.87 to 5.83 over the next best,
// and all three judges picked it independently. Every glyph is one solid mass with no interior
// detail thinner than about 5 units, which is what survives 72 pixels.
//
// NO LETTERS AND NO PUNCTUATION. These buttons carry no caption, so a shape that needs one is
// no use - and a glyph that is really a character is a caption in disguise.
//
// Three of these were redrawn after the judging, from defects all three judges found:
//   - `recording` was a ring with a dot in it. `unknown` was a ring broken into arcs. Two
//     concentric-ring silhouettes, adjacent on the deck, differing only in fine detail - and
//     gaps are the first thing a 72-pixel glance loses. Recording is now the solid dot the
//     transport symbol actually is, and unknown left the circle entirely.
//   - `interruptible` KEPT its caution triangle, against the judges' semantic objection. See
//     the note on it below; the objection is real and was overruled on purpose.

export const ICONS = {
	// TICK. ISO "correct / permitted". The only unenclosed silhouette in the set, and the
	// furthest possible shape from the barred disc below it - which is the separation that
	// matters most, because mistaking ON AIR for AVAILABLE is the catastrophic direction.
	available: (c, p) => {
		c.line(15, 38, 30, 53, 11, p.ink)
		c.line(30, 53, 58, 18, 11, p.ink)
	},

	// NO ENTRY. Solid disc, barred. Encodes the INSTRUCTION rather than the cause, which is
	// what a person outside the door needs.
	'on-air': (c, p) => {
		c.circle(36, 36, 27, p.ink)
		c.rect(6, 30, 60, 12, null)
	},

	// CAUTION TRIANGLE (ISO 7010 W001).
	//
	// KEPT AGAINST THE JUDGING, and the reason is the invariant. All three judges said the
	// same thing: this reads "fault", not "you may interrupt if it matters". They are right.
	// Four alternatives were drawn and looked at on the real amber: a knocking fist (an
	// unreadable blob at 72), a half-lit disc (crisp, but a disc - and ON AIR is a disc, so
	// the confusable pair became the one pair that must never be confused), a door standing
	// ajar (crisp and the best semantic fit) and pause bars (says "paused", not "interruptible").
	//
	// The door lost to the triangle on which way each one FAILS. A door ajar misread says
	// "come in, it is fine"; a triangle misread says "careful". This system's cardinal sin is
	// a false OFF - telling somebody it is fine to walk in when it is not (D-6, D-63) - so the
	// icon that errs toward caution is the correct one even though it is the worse picture.
	interruptible: (c, p) => {
		c.polygon(
			[
				[36, 6],
				[66, 62],
				[6, 62],
			],
			p.ink,
		)
		c.rect(31.5, 24, 9, 20, null)
		c.circle(36, 52, 5, null)
	},

	// RECORD. The transport symbol is a solid dot and always was; the ring around it was
	// decoration that cost the icon its silhouette.
	recording: (c, p) => {
		c.circle(36, 36, 24, p.ink)
	},

	// NO DATA. A square whose sides never join: the placeholder that never filled in. Square
	// rather than round on purpose - it was a broken ring, directly beneath another ring, and
	// at deck distance the pair read as one shape.
	unknown: (c, p) => {
		c.rect(20, 8, 32, 9, p.ink)
		c.rect(20, 55, 32, 9, p.ink)
		c.rect(8, 20, 9, 32, p.ink)
		c.rect(55, 20, 9, 32, p.ink)
	},

	// MOON. The highest-scoring icon in the whole field, on any sheet.
	sleep: (c, p) => {
		c.circle(38, 36, 27, p.ink)
		c.circle(25, 25, 25, null)
	},

	// SUN. The only pair in the field that is obviously OPPOSITE rather than a variation on
	// one shape - which is the whole job of two buttons that undo each other.
	wake: (c, p) => {
		c.circle(36, 36, 13, p.ink)
		for (let i = 0; i < 8; i++) {
			const a = (i * Math.PI) / 4
			const dx = Math.cos(a)
			const dy = Math.sin(a)
			c.line(36 + dx * 19, 36 + dy * 19, 36 + dx * 28, 36 + dy * 28, 7, p.ink)
		}
	},

	// NEXT STATE. The near-universal rotate glyph: a ring with a bite taken out of it and an
	// arrowhead on the leading end.
	//
	// The bite is 55 degrees wide because a THIN one is the failure here - a circle that not
	// quite closes is `unknown`, sitting on the next key over, and two glyphs that differ only
	// in how much of a ring is missing is the exact defect the judges found in the first pass
	// of this set (D-135). The arrowhead is what carries the meaning; the gap only has to be
	// wide enough that the head reads as travelling rather than as a nick in the outline.
	cycle: (c, p) => {
		const cx = 36
		const cy = 36
		const rOut = 29
		const rIn = 20
		const from = 12
		const end = 317
		c.arc(cx, cy, rOut, rIn, from, end, p.ink)
		const a = (end * Math.PI) / 180
		const ux = Math.cos(a)
		const uy = Math.sin(a)
		// The tangent in the direction of travel, which is where the head must point. `arc`
		// sweeps clockwise on screen, so this is the radius turned a quarter turn the same way.
		const tx = -uy
		const ty = ux
		const bx = cx + ((rOut + rIn) / 2) * ux
		const by = cy + ((rOut + rIn) / 2) * uy
		c.polygon(
			[
				[bx + tx * 15, by + ty * 15],
				[bx - ux * 13, by - uy * 13],
				[bx + ux * 13, by + uy * 13],
			],
			p.ink,
		)
	},
}
