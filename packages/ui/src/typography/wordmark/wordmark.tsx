import { createUniqueId, type ComponentProps } from "solid-js"

const wordmark = [
  "M20 18H40L80 68L120 18H140V128H120V64L80 110L40 64V128H20Z",
  "M170 18H290V38H190V68H270V88H190V108H290V128H170Z",
  "M320 18H340L380 68L420 18H440V128H420V64L380 110L340 64V128H320Z",
  "M470 18H494L530 66L566 18H590L540 92V128H520V92Z",
  "M620 18H720V88H680L740 128H712L660 88H640V128H620V18ZM640 38V68H700V38H640Z",
]

export function Wordmark(
  props: Pick<ComponentProps<"svg">, "class"> & { fade?: boolean; muted?: boolean; outline?: boolean },
) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 760 129"
      fill="none"
      classList={{
        [props.class ?? ""]: !!props.class,
        "overflow-visible [&_path]:[vector-effect:non-scaling-stroke]": props.outline,
      }}
    >
      <g opacity={props.muted === false ? 1 : 0.6} class="[[data-color-scheme=dark]_&]:opacity-100">
        <g mask={props.fade === false ? undefined : `url(#${mask})`}>
          <g
            opacity={props.muted === false ? 1 : 0.16 * 0.7}
            fill={props.outline ? "none" : "currentColor"}
            stroke={props.outline ? "currentColor" : undefined}
            stroke-width={props.outline ? 1 : undefined}
          >
            {wordmark.map((path, index) => (
              <path
                pathLength={props.outline ? 1 : undefined}
                fill-rule={index === wordmark.length - 1 ? "evenodd" : undefined}
                d={path}
              />
            ))}
          </g>
        </g>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="760" height="129">
          <rect width="760" height="129" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1="380" y1="68" x2="380" y2="129" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
