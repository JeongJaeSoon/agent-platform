/**
 * The card's model picker and the release form's model check, kept apart
 * from ko.ts and en.ts like sessions.ts; both catalogs spread these in.
 */
export const modelsKo = {
  "agentCard.modelPick": "모델을 고르세요",
  "agentCard.modelOption": "{model} · {profiles}",
  "agentCard.modelUncataloged": "{model} · 카탈로그에 없음",
  "agentCard.modelUncatalogedWarning":
    "이 모델은 카탈로그에 없어 이 카드로는 release를 만들 수 없습니다. 바꾸지 않으면 그대로 저장됩니다.",
  "agentCard.modelsLoading":
    "모델 목록을 불러오는 중… 다 불러온 뒤에 저장할 수 있습니다.",
  "agentCard.modelsFailed":
    "모델 목록을 불러오지 못해 저장할 수 없습니다: {reason}",

  "agent.releases.modelMismatch":
    "카드 모델(이 version): {card} · 고른 프로필의 모델: {profile}. 둘이 달라 이대로 만들면 거부됩니다.",
  "agent.releases.profileOptionMismatch":
    "{profile} · {model} · 카드 모델과 다름",
  "agent.releases.modelRefused":
    "카드 모델 {card}이(가) 프로필 {profile}의 모델과 달라 release를 만들지 못했습니다. 카드 모델과 같은 모델의 프로필을 고르세요.",
};

export const modelsEn: Record<keyof typeof modelsKo, string> = {
  "agentCard.modelPick": "Choose a model",
  "agentCard.modelOption": "{model} · {profiles}",
  "agentCard.modelUncataloged": "{model} · not in the catalog",
  "agentCard.modelUncatalogedWarning":
    "This model is not in the catalog, so this card cannot be released. If you leave it, it is saved as it is.",
  "agentCard.modelsLoading":
    "Loading the models… You can save once they are loaded.",
  "agentCard.modelsFailed":
    "Could not load the models, so you cannot save: {reason}",

  "agent.releases.modelMismatch":
    "This version's card uses {card}, but the chosen profile runs {profile}. A release like this is refused.",
  "agent.releases.profileOptionMismatch":
    "{profile} · {model} · not the card's model",
  "agent.releases.modelRefused":
    "The card's model {card} is not the model of profile {profile}, so no release was created. Choose a profile that runs the card's model.",
};
