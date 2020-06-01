import {
  IsDefined,
  MinLength,
  IsDate as CVIsDate /* aliases work ok */,
} from 'class-validator';
// Decorators that are not imported from CV are discarded
import IsSomething from 'some-module';

// Decorators that are not imported from CV are discarded
const GarbageDecorator = (): PropertyDecorator => (
  _target: any,
  _propertyKey: any
) => {};
/*
 * Class-validator-gen cannot figure out that this decorator is coming from CV,
 * hence it is ignored
 */
const MyDecorator = IsDefined;

export class User {
  @GarbageDecorator()
  @IsDefined({ message: 'Custom error message' })
  @IsNumberString({})
  @MinLength(10, '20', /30/)
  name!: string;

  @CVIsDate()
  dateOfBirth!: string;

  @IsSomething()
  @MyDecorator()
  status!: string;
}

// This class does not have CV decorators, hence it is discarded
export class Garbage {}
