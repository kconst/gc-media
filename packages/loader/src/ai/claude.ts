import fs from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import {
  emptyLabels,
  LABEL_CATEGORIES,
  type Analysis,
  type Labels,
} from "@gc-media/shared";
import { config } from "../config.js";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are a nature and travel photo/video analyst documenting a Grand Canyon
backpacking trip (South Rim, Bright Angel Trail and South Kaibab Trail).
For each asset you are given one or more images (a photo, or sampled frames
from a video clip). Produce:

1. description: an in-depth, vivid paragraph describing exactly what is shown —
   the setting, geology, light/time of day, activity, and anything notable a
   viewer would want to know. Write for someone reliving the trip.
2. labels, grouped into four categories. Only include items actually visible;
   leave a category empty if nothing applies. Use concise, lowercase noun
   phrases.
   - plants: species/types of vegetation (e.g. "prickly pear", "cottonwood").
   - animals: wildlife seen (e.g. "mule deer", "raven", "bighorn sheep").
   - peopleMorale: the mood/state of people if present (e.g. "exhausted",
     "elated at the summit", "taking a water break").
   - interesting: other noteworthy things (e.g. "Colorado River", "switchbacks",
     "rock strata", "suspension bridge", "sunrise").

Always call the record_analysis tool with your result.`;

const tool: Anthropic.Tool = {
  name: "record_analysis",
  description: "Record the structured analysis of the asset.",
  input_schema: {
    type: "object",
    properties: {
      description: { type: "string" },
      labels: {
        type: "object",
        properties: Object.fromEntries(
          LABEL_CATEGORIES.map((c) => [
            c,
            { type: "array", items: { type: "string" } },
          ]),
        ),
        required: [...LABEL_CATEGORIES],
      },
    },
    required: ["description", "labels"],
  },
};

let client: Anthropic | undefined;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: config.anthropicApiKey() });
  return client;
}

async function imageBlock(path: string): Promise<Anthropic.ImageBlockParam> {
  const data = (await fs.readFile(path)).toString("base64");
  return {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data },
  };
}

/** Analyze one asset given JPEG images (a photo, or sampled video frames). */
export async function analyzeImages(
  imagePaths: string[],
  isVideo: boolean,
): Promise<Analysis> {
  const images = await Promise.all(imagePaths.map(imageBlock));
  const intro = isVideo
    ? "These are frames sampled in order from a single video clip."
    : "This is a single photo.";

  const res = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    tools: [tool],
    tool_choice: { type: "tool", name: "record_analysis" },
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: intro }, ...images],
      },
    ],
  });

  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("Claude did not return a tool_use block");
  }
  const input = block.input as { description?: string; labels?: Partial<Labels> };
  const labels = emptyLabels();
  for (const c of LABEL_CATEGORIES) {
    const v = input.labels?.[c];
    if (Array.isArray(v)) labels[c] = v.filter((x): x is string => typeof x === "string");
  }
  return { description: input.description ?? "", labels };
}
