export const NORSE_THEME_ID = "norse"

export type NorseThemeID = typeof NORSE_THEME_ID

export function isNorseTheme(id: string | undefined): id is NorseThemeID {
  return id === NORSE_THEME_ID
}
