// The composer's skill picker (T14/S1): opened by the "Use skill" button or
// by typing "/" at the start of the message. Picking a skill turns it on for
// the open conversation; the composer shows it as a removable pill.

import { useT } from "../i18n";
import { IconBolt, IconPlus } from "../icons";
import type { Skill } from "./skills";

export type SkillPickerProps = {
  /** The skills to offer (already filtered by the "/" query). */
  items: Skill[];
  /** Whether the user has any skill at all (empty vs no match). */
  hasSkills: boolean;
  /** The highlighted option (keyboard). */
  activeIndex: number;
  onPick: (skill: Skill) => void;
  onCreate: () => void;
};

export function SkillPicker({ items, hasSkills, activeIndex, onPick, onCreate }: SkillPickerProps) {
  const t = useT();
  const s = t.skills;
  return (
    <div className="skill-picker">
      <p className="skill-picker-title" id="skill-picker-title">
        {s.pickerLabel}
      </p>
      {items.length > 0 ? (
        <ul className="skill-picker-list" role="listbox" aria-labelledby="skill-picker-title">
          {items.map((skill, index) => (
            <li
              key={skill.id}
              id={`skill-option-${skill.id}`}
              role="option"
              aria-selected={index === activeIndex}
              className={`skill-option${index === activeIndex ? " active" : ""}`}
              // mousedown keeps the composer focused (no blur flash).
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(skill)}
            >
              <IconBolt size={14} />
              <span className="skill-option-text">
                <span className="skill-option-title">{skill.title}</span>
                <span className="skill-option-description">{skill.description}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="skill-picker-empty">{hasSkills ? s.pickerNoMatch : s.pickerEmpty}</p>
      )}
      {!hasSkills && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCreate}>
          <IconPlus size={14} />
          {s.pickerCreate}
        </button>
      )}
    </div>
  );
}
