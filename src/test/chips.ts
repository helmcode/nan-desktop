// Answers show their sources and files in collapsed sections
// (components/ChipSection). Tests that use the chips expand them first.
import { fireEvent, screen } from "@testing-library/react";

const SECTION_NAME = /^(Files|Archivos|Sources|Fuentes)/;

/// Wait for the collapsed chip sections on screen and expand every one.
export async function openChipSections(): Promise<void> {
  const toggles = await screen.findAllByRole("button", { name: SECTION_NAME, expanded: false });
  for (const toggle of toggles) fireEvent.click(toggle);
}
