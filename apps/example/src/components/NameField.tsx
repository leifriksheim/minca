/** The name others see, asked when making or joining a space */
export function NameField({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  return (
    <label>
      What should people call you?
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Your name"
        maxLength={64}
        autoComplete="name"
      />
    </label>
  );
}
