/**
 * Vendored Standard Schema V1 interface (https://standardschema.dev — MIT).
 * The spec is designed to be copied: it is types-only, so vendoring it keeps
 * @telic/core at zero dependencies while accepting Zod 3.24+/4, Valibot,
 * ArkType, or any other implementing library.
 */
export type StandardSchemaV1<Input = unknown, Output = Input> = {
	readonly "~standard": StandardSchemaV1.Props<Input, Output>;
};

export declare namespace StandardSchemaV1 {
	export type Props<Input = unknown, Output = Input> = {
		readonly version: 1;
		readonly vendor: string;
		readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
		readonly types?: Types<Input, Output> | undefined;
	};

	export type Result<Output> = SuccessResult<Output> | FailureResult;

	export type SuccessResult<Output> = {
		readonly value: Output;
		readonly issues?: undefined;
	};

	export type FailureResult = {
		readonly issues: ReadonlyArray<Issue>;
	};

	export type Issue = {
		readonly message: string;
		readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
	};

	export type PathSegment = {
		readonly key: PropertyKey;
	};

	export type Types<Input = unknown, Output = Input> = {
		readonly input: Input;
		readonly output: Output;
	};

	export type InferInput<S extends StandardSchemaV1> = NonNullable<
		S["~standard"]["types"]
	>["input"];

	export type InferOutput<S extends StandardSchemaV1> = NonNullable<
		S["~standard"]["types"]
	>["output"];
}
