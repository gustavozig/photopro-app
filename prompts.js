// prompts.js
// "Prompts mágicos" — um por estilo. A parte de preservação de identidade é
// compartilhada por todos, porque é a promessa central do produto:
// "continua sendo você, só que pronto para currículo e LinkedIn".

const IDENTITY_LOCK = `
Edit this selfie into a professional headshot photograph.
CRITICAL — identity preservation (do not violate):
- Keep the exact same person: same face shape, same eyes, same nose, same mouth,
  same skin tone, same hairstyle and hair color, same approximate age.
- Do not beautify, slim, or reshape the face. Do not change ethnicity or gender presentation.
- The result must be immediately recognizable as the same individual in the original photo,
  just professionally dressed, lit, and framed.
Technical requirements:
- Head-and-shoulders composition, subject centered, looking at the camera, natural relaxed expression.
- Sharp focus on the face, shallow depth of field on the background.
- Photo-realistic, DSLR quality, no illustration/painting/CGI look, no text or watermark.
`.trim();

const STYLE_PROMPTS = {
  'Executivo(a)': `${IDENTITY_LOCK}

Wardrobe & setting for this version — "Executivo(a)":
- Dress the subject in a well-tailored dark navy or charcoal business suit with a crisp white or
  light blue collared shirt (add a subtle tie only if the subject presents as masculine; a clean
  blouse/blazer combo if feminine).
- Background: a softly blurred modern office environment (glass walls, soft window light, muted
  neutral tones), suggesting an executive/corporate workplace, out of focus (bokeh).
- Lighting: soft, directional studio light from the front-left, gentle fill light to avoid harsh
  shadows, warm-neutral color temperature that conveys authority and trust.`,

  'Corporativo neutro': `${IDENTITY_LOCK}

Wardrobe & setting for this version — "Corporativo neutro":
- Dress the subject in simple, neutral business attire (a plain blazer over a solid-color shirt/blouse,
  no loud patterns), in gray, navy, or black tones.
- Background: a flat, smooth light-gray studio background (seamless paper backdrop look), evenly lit,
  no props, no texture, completely neutral.
- Lighting: even, soft studio lighting typical of corporate ID/LinkedIn photos, minimal shadow, clean
  and simple look.`,

  'Casual elegante': `${IDENTITY_LOCK}

Wardrobe & setting for this version — "Casual elegante":
- Dress the subject in smart-casual attire: a well-fitted knit sweater, or an open-collar shirt without
  a tie, or a casual blazer without a tie — polished but relaxed, no gravata.
- Background: a softly blurred neutral setting with warm, approachable tones (light beige, soft green,
  or warm gray), slightly more relaxed than a corporate office.
- Lighting: soft and warm, slightly more natural-light feeling, approachable and friendly mood while
  still looking professional and high-quality.`,

  'Fundo estúdio': `${IDENTITY_LOCK}

Wardrobe & setting for this version — "Fundo estúdio":
- Dress the subject in clean, simple professional attire appropriate for a studio portrait (solid
  color shirt/blouse or blazer, no busy patterns).
- Background: an infinite seamless studio backdrop in neutral light-gray or off-white, perfectly even,
  classic studio headshot look, no environment or props at all.
- Lighting: classic three-point studio portrait lighting (key, fill, and subtle rim light), crisp and
  polished, similar to professional portrait studio photography.`,
};

const DEFAULT_STYLE = 'Corporativo neutro';

function getPromptForStyle(styleName) {
  return STYLE_PROMPTS[styleName] || STYLE_PROMPTS[DEFAULT_STYLE];
}

module.exports = { getPromptForStyle, STYLE_PROMPTS, DEFAULT_STYLE };
