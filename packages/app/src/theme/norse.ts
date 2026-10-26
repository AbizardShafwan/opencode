export const NORSE_THEME_ID = "norse"

export type NorseThemeID = typeof NORSE_THEME_ID

export const NORSE_COPY = {
  greeting: "norse.welcome",
  subtitle: "norse.subtitle",
} as const


export function isNorseTheme(id: string | undefined): id is NorseThemeID {
  return id === NORSE_THEME_ID
}
