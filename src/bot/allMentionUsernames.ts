// Manually supplied participants, including users the bot has not seen yet.
export const allMentionUsernames = [
  "kelik2",
  "shika_max",
  "b4wb0le1l0",
  "shucheva_kate",
  "asolld",
  "Garick_17",
  "JohnNik001",
  "m4r14Ef",
  "pbntanushka",
  "ywmskee",
  "i_simply_am_not_there_2003",
  "ww_ksnzz",
  "young_Trezzini",
  "z1s1b",
  "linchevately",
  "dark_dragonn",
  "haapy_meal",
  "ILYAPICHEVGod",
  "finessemashina",
  "bodyableat",
  "feduk17",
  "gl0ssygl0g",
  "alice_lakhtikova",
  "tomms3",
  "edutvv",
  "makarov9963",
] as const;

export interface AllMentionsConfig {
  usernames: readonly string[];
  chatId?: number;
  log?: (event: Record<string, unknown>) => void;
  now?: () => number;
}
