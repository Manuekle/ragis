import { useReducedMotion } from "motion/react";
import { noBounce, Spring } from "./physics";

// Reduced motion keeps everything the finger drives exactly as it is (that
// motion is the user's own) and softens only what moves by itself: springs
// settle without overshooting, and big automatic movements become fades.
export const useMotionPreference = () => {
  const reduceMotion = useReducedMotion() ?? false;
  const spring = (value: Spring) => (reduceMotion ? noBounce(value) : value);
  return { reduceMotion, spring };
};
