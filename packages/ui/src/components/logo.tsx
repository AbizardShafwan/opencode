import { type ComponentProps } from "solid-js"

const mark = "M0 0H20L60 50L100 0H120V110H100V46L60 92L20 46V110H0Z"

const wordmark = [
  "M20 18H40L80 68L120 18H140V128H120V64L80 110L40 64V128H20Z",
  "M170 18H290V38H190V68H270V88H190V108H290V128H170Z",
  "M320 18H340L380 68L420 18H440V128H420V64L380 110L340 64V128H320Z",
  "M470 18H494L530 66L566 18H590L540 92V128H520V92Z",
  "M620 18H720V88H680L740 128H712L660 88H640V128H620V18ZM640 38V68H700V38H640Z",
]

export const Mark = (props: ComponentProps<"svg">) => {
  return (
    <svg {...props} data-component="logo-mark" viewBox="0 0 120 110" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path data-slot="logo-logo-mark-m" d={mark} fill="currentColor" />
    </svg>
  )
}

export const Splash = (props: ComponentProps<"svg">) => {
  return (
    <svg
      {...props}
      data-component="logo-splash"
      viewBox="0 0 120 110"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d={mark} fill="currentColor" />
    </svg>
  )
}

export const Logo = (props: ComponentProps<"svg">) => {
  return (
    <svg {...props} data-component="logo-wordmark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 129" fill="none">
      <g fill="currentColor">
        {wordmark.map((path, index) => (
          <path d={path} fill-rule={index === wordmark.length - 1 ? "evenodd" : undefined} />
        ))}
      </g>
    </svg>
  )
}
